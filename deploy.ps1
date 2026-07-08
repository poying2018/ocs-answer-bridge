# OCS Answer Bridge 自动部署脚本 (PowerShell)
# 用法: .\deploy.ps1 -CFToken "你的Cloudflare_API_Token" [-ApiKey "你的AI_API_Key"] [-AuthKey "你的AUTH_KEY"]
param(
    [Parameter(Mandatory=$true)]
    [string]$CFToken,
    [string]$ApiKey = "<YOUR_AI_API_KEY>",
    [string]$AuthKey = "<YOUR_AUTH_KEY>"
)

$ErrorActionPreference = "Stop"
$env:CLOUDFLARE_API_TOKEN = $CFToken

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $ProjectDir

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " OCS Answer Bridge 部署" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. 初始化 D1 表（全新库建表；存量库 IF NOT EXISTS 自动跳过）
Write-Host "[1/5] 初始化 D1 数据库表（schema.sql）..." -ForegroundColor Yellow
wrangler d1 execute ocs --remote --file=schema.sql
if ($LASTEXITCODE -ne 0) {
    Write-Warning "建表失败或已存在，继续执行迁移..."
}

# 2. 确保缓存表含 cache_version 列且唯一约束正确（migrations/001 幂等、安全重建，可重复执行）
Write-Host "[2/5] 迁移：确保表结构正确（migrations/001_cache_version.sql）..." -ForegroundColor Yellow
wrangler d1 execute ocs --remote --file=migrations/001_cache_version.sql
if ($LASTEXITCODE -ne 0) { throw "缓存版本迁移失败" }

# 3. 设置 AUTH_KEY
Write-Host "[3/5] 设置 AUTH_KEY..." -ForegroundColor Yellow
$AuthKey | wrangler secret put AUTH_KEY
if ($LASTEXITCODE -ne 0) { throw "设置 AUTH_KEY 失败" }

# 4. 设置 API_KEY
Write-Host "[4/5] 设置 API_KEY..." -ForegroundColor Yellow
$ApiKey | wrangler secret put API_KEY
if ($LASTEXITCODE -ne 0) { throw "设置 API_KEY 失败" }

# 5. 部署 Worker（缓存与模型解耦，部署不会清空缓存）
Write-Host "[5/5] 部署 Worker..." -ForegroundColor Yellow
wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "部署失败" }

Write-Host "========================================" -ForegroundColor Green
Write-Host " 部署完成!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "测试: https://<YOUR_DOMAIN>/?key=$AuthKey&title=测试题目" -ForegroundColor White
Write-Host "统计: https://<YOUR_DOMAIN>/stats" -ForegroundColor White
Write-Host "健康: https://<YOUR_DOMAIN>/health" -ForegroundColor White

Pop-Location
