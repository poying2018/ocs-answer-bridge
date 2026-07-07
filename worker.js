// OCS Answer Bridge — Cloudflare Worker
// 功能：接收 OCS 答题请求 → 先查 D1 题库缓存 → 命中则返回，未命中则调用 AI 并写入缓存
// 部署：wrangler deploy（wrangler.toml 已声明 D1 绑定，部署时自动绑定）
// 缓存版本：CACHE_VERSION 变更后，旧答案视为失效并自动重新生成（解决错误答案永久固化问题）

// 选择题答案超长时，仅保留正确选项字母（如 "A、B、C"），避免 OCS 端显示过长。
// 仅当文本中出现「X. / X、/ X。」形式的选项字母时才压缩；论述题、判断题不含此类字母，不受影响。
const MAX_ANSWER_LEN = 200
function compressToLetters(text) {
  const letters = [...text.matchAll(/(?<![A-Za-z])([A-Z])(?=\s*[.、。])/g)].map(m => m[1])
  const seen = new Set()
  const uniq = []
  for (const l of letters) {
    if (!seen.has(l)) { seen.add(l); uniq.push(l) }
  }
  return uniq.length >= 1 ? uniq.join('、') : null
}

// 提取答案中作为选项出现的字母（A-D），用于多选题完整性校验
function extractOptionLetters(text) {
  if (!text) return []
  const letters = [...text.matchAll(/(?<![A-Za-z])([A-D])(?=[\s.、。,)）:]|$)/g)].map(m => m[1])
  const seen = new Set()
  const uniq = []
  for (const l of letters) {
    if (!seen.has(l)) { seen.add(l); uniq.push(l) }
  }
  return uniq
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    // 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    const url = new URL(request.url)

    // 健康检查（无需鉴权）
    if (url.pathname === '/health' || url.searchParams.get('health') === '1') {
      const dbOk = !!env.DB
      return new Response(JSON.stringify({ status: 'ok', db: dbOk ? 'bound' : 'NOT_BOUND' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 缓存统计（无需鉴权）
    if (url.pathname === '/stats') {
      if (!env.DB) {
        return new Response(JSON.stringify({ error: 'DB not bound' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      try {
        const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM answers').first()
        return new Response(JSON.stringify({ cached: row?.total ?? 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    const key = url.searchParams.get('key') || ''
    const title = (url.searchParams.get('title') || '').trim()
    const options = (url.searchParams.get('options') || '').trim()

    // 鉴权
    if (env.AUTH_KEY && key !== env.AUTH_KEY) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 管理端点（同样受上方 AUTH_KEY 保护，必须带正确 key 才能访问）
    if (url.pathname.startsWith('/admin/')) {
      if (!env.DB) {
        return new Response(JSON.stringify({ error: 'DB not bound' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      // 全量清理缓存
      if (url.pathname === '/admin/clear-all') {
        try {
          const info = await env.DB.prepare('DELETE FROM answers').run()
          return new Response(JSON.stringify({ ok: true, cleared: 'all', changes: info?.meta?.changes ?? null }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        }
      }
      // 单条清理：按 title + options 失效（options 可省略）
      if (url.pathname === '/admin/clear') {
        const t = (url.searchParams.get('title') || '').trim()
        const o = (url.searchParams.get('options') || '').trim()
        if (!t) {
          return new Response(JSON.stringify({ error: 'missing title' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        }
        try {
          const info = await env.DB.prepare(
            'DELETE FROM answers WHERE title = ? AND options = ?'
          ).bind(t, o).run()
          return new Response(JSON.stringify({ ok: true, cleared: { title: t, options: o }, changes: info?.meta?.changes ?? null }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        }
      }
      return new Response(JSON.stringify({ error: 'unknown admin path' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!title) {
      return new Response(JSON.stringify({ error: 'missing title' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // D1 绑定检查（显式报错，不再静默吞掉）
    if (!env.DB) {
      return new Response(JSON.stringify({ error: 'DB_NOT_BOUND', hint: 'Worker 未绑定 D1 数据库，请检查 wrangler.toml 与 Dashboard Bindings' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 1. 先查缓存（带缓存版本，版本不符视为未命中，自动重新生成）
    const cacheVersion = env.CACHE_VERSION || '1'
    try {
      const cached = await env.DB.prepare(
        'SELECT answer FROM answers WHERE title = ? AND options = ? AND cache_version = ?'
      ).bind(title, options, cacheVersion).first()
      if (cached) {
        return new Response(JSON.stringify({ answer: cached.answer, source: 'cache' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    } catch (e) {
      console.error('Cache query error:', e)
      // 查询异常不阻断答题，继续走 AI
    }

    // 2. 调用 AI API
    // API_KEY 缺失检查（仅未命中缓存、即将调用 AI 时校验，避免误导性的 Bearer undefined 模糊 401）
    if (!env.API_KEY) {
      return new Response(JSON.stringify({ error: 'API_KEY_NOT_SET', hint: 'Worker 未配置 API_KEY。请执行 `wrangler secret put API_KEY` 或在 Dashboard Variables 中设置加密变量。' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const apiBase = env.API_BASE || 'https://api.siliconflow.cn'
    const model = env.MODEL || 'deepseek-ai/DeepSeek-V3'
    const systemPrompt = env.SYSTEM_PROMPT || `你是一个答题助手，直接给出答案，不要解释。
【格式要求】
- 单选题：给出正确选项的字母及内容，如「A. 内容」。
- 多选题：必须列出【全部】正确选项（可能有两个或两个以上），格式如「A. 内容 B. 内容 C. 内容」。请逐一核对每一个选项，多选题绝不可只输出一个选项就结束，也绝不可遗漏任何正确选项。
- 判断题：只回答「正确」或「错误」。
- 简答题/论述题：直接写论述内容，不要使用 A、B、C、D 分点。
【示例】
题目：以下哪些属于可再生能源？
选项：A. 太阳能 B. 风能 C. 煤炭 D. 核能
答案：A. 太阳能 B. 风能

题目：下列哪些数是质数？
选项：A. 2 B. 3 C. 4 D. 9
答案：A. 2 B. 3`

    const userContent = options
      ? `题目：${title}\n选项：${options}`
      : `题目：${title}`

    // 调用上游 AI（封装为函数以便多选题兜底重试）
    const callAI = async (systemContent) => {
      const r = await fetch(`${apiBase}/v1/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(25000),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: userContent },
          ],
          temperature: 0,
          max_tokens: 4096,
        }),
      })
      if (!r.ok) {
        const err = await r.text()
        const e = new Error(err)
        e.status = r.status
        throw e
      }
      const d = await r.json()
      return (d?.choices?.[0]?.message?.content ?? '').trim() || null
    }

    let answer
    try {
      answer = await callAI(systemPrompt)
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.status || 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 多选题完整性兜底：题目含多选信号词且首答仅 1 个选项时，用强调指令重试一次
    const multiHint = /多选|哪些|不止一个|可多选|以下几项?|符合.{0,6}的有|哪些?属于|哪些?是|全选|都正确|均正确/.test(title + ' ' + options)
    if (answer && multiHint) {
      const firstLetters = extractOptionLetters(answer)
      if (firstLetters.length <= 1) {
        try {
          const retryAnswer = await callAI(
            systemPrompt + '\n\n【关键】本题是多选题，你必须列出【全部】正确选项，绝不能只给一个选项就结束。请重新给出完整答案，包含所有正确选项及其内容。'
          )
          if (retryAnswer) {
            const retryLetters = extractOptionLetters(retryAnswer)
            // 仅当重试拿到更多选项时才采纳，避免误覆盖
            if (retryLetters.length > firstLetters.length) {
              answer = retryAnswer
            }
          }
        } catch (e) {
          console.error('Multi-choice retry failed:', e)
        }
      }
    }

    // 选择题答案过长时压缩为仅选项字母（论述/判断不含字母，不触发）
    if (answer && answer.length > MAX_ANSWER_LEN) {
      const compressed = compressToLetters(answer)
      if (compressed) answer = compressed
    }

    // 3. 写入缓存
    if (answer) {
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO answers (title, options, answer, cache_version) VALUES (?, ?, ?, ?)'
        ).bind(title, options, answer, cacheVersion).run()
      } catch (e) {
        console.error('Cache save error:', e)
      }
    }

    return new Response(JSON.stringify({ answer, source: 'ai' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  },
}
