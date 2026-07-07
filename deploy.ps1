# OCS AI Proxy 自动部署脚本 (PowerShell)
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
Write-Host " OCS AI Proxy 部署" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. 初始化 D1 表
Write-Host "[1/4] 初始化 D1 数据库表..." -ForegroundColor Yellow
wrangler d1 execute ocs --remote --file=schema.sql
if ($LASTEXITCODE -ne 0) {
    Write-Warning "表初始化失败或已存在，继续执行..."
}

# 2. 设置 AUTH_KEY
Write-Host "[2/4] 设置 AUTH_KEY..." -ForegroundColor Yellow
$AuthKey | wrangler secret put AUTH_KEY
if ($LASTEXITCODE -ne 0) { throw "设置 AUTH_KEY 失败" }

# 3. 设置 API_KEY
Write-Host "[3/4] 设置 API_KEY..." -ForegroundColor Yellow
$ApiKey | wrangler secret put API_KEY
if ($LASTEXITCODE -ne 0) { throw "设置 API_KEY 失败" }

# 4. 部署
Write-Host "[4/4] 部署 Worker..." -ForegroundColor Yellow
wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "部署失败" }

Write-Host "========================================" -ForegroundColor Green
Write-Host " 部署完成!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "测试: https://<YOUR_DOMAIN>/?key=$AuthKey&title=测试题目" -ForegroundColor White
Write-Host "统计: https://<YOUR_DOMAIN>/stats" -ForegroundColor White
Write-Host "健康: https://<YOUR_DOMAIN>/health" -ForegroundColor White

Pop-Location
