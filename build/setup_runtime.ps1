# 產生自帶式執行環境（在「有對外網路」的建置機上執行一次）。
# 完成後 runtime\ 內含：可攜式 Python 3.11 + 所有相依套件；
# 之後把整個專案資料夾（含 runtime\）複製到 IIS 測試機即可，目標機不需安裝任何 Python 或套件。
#
# 用法（PowerShell，於專案根目錄）：  .\build\setup_runtime.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pyVer = '3.11.9'
$runtime = Join-Path $root 'runtime'
$pyDir = Join-Path $runtime 'python'
$siteDir = Join-Path $runtime 'site-packages'

New-Item -ItemType Directory -Force -Path $runtime | Out-Null

# 1) 下載並解壓可攜式（embeddable）Python
if (-not (Test-Path (Join-Path $pyDir 'python.exe'))) {
  $zip = Join-Path $env:TEMP "python-$pyVer-embed-amd64.zip"
  $url = "https://www.python.org/ftp/python/$pyVer/python-$pyVer-embed-amd64.zip"
  Write-Host "下載 $url"
  Invoke-WebRequest -Uri $url -OutFile $zip
  if (Test-Path $pyDir) { Remove-Item -Recurse -Force $pyDir }
  Expand-Archive -Path $zip -DestinationPath $pyDir -Force
}

# 2) 讓可攜式 Python 找得到 site-packages 與 api（改 ._pth 並啟用 site）
$pth = Get-ChildItem -Path $pyDir -Filter 'python*._pth' | Select-Object -First 1
@"
python311.zip
.
..\site-packages
..\..\api
import site
"@ | Set-Content -Encoding ASCII $pth.FullName

# 3) 安裝相依套件到 site-packages（用建置機上的 Python 皆可；此處用系統 python）
Write-Host "安裝相依套件到 $siteDir"
python -m pip install --upgrade --target $siteDir -r (Join-Path $root 'api\requirements.txt')

New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
Write-Host "完成。runtime\ 已就緒，可連同專案複製到 IIS 測試機。" -ForegroundColor Green
