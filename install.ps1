# Install Pi (if missing) and the pi-verboo-provider package.
#
# Works on Windows PowerShell 5.1+ and PowerShell 7+.
# Usage:
#   ./install.ps1
#   $env:VERBOO_PI_SOURCE = 'npm:@ivancavero/pi-verboo-provider'; ./install.ps1
#
# This script never handles your API key and never runs sudo.

$ErrorActionPreference = 'Stop'

$NpmPackage = 'npm:@ivancavero/pi-verboo-provider'
$GitSource = 'git:github.com/ivan-cavero/pi-verboo-provider'
$PiPackage = '@earendil-works/pi-coding-agent'

function Show-Usage {
	@'
Install Pi (if missing) and the pi-verboo-provider package.

Usage:
  ./install.ps1

Environment:
  VERBOO_PI_SOURCE   Override the source passed to `pi install`.
                     Default: npm:@ivancavero/pi-verboo-provider when the npm
                     registry has it, otherwise git:github.com/ivan-cavero/pi-verboo-provider.

After install:
  $env:VERBOO_API_KEY = '...'   # or run /login verboo inside pi
  pi --list-models verboo
'@
}

# Run a native command and capture its output and exit code without letting
# stderr output trip $ErrorActionPreference = 'Stop'.
function Invoke-Native {
	param(
		[Parameter(Mandatory = $true)][string]$Command,
		[Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments = @()
	)

	$previous = $ErrorActionPreference
	$ErrorActionPreference = 'Continue'
	try {
		$output = & $Command @Arguments 2>&1 | Out-String
		$code = $LASTEXITCODE
	}
	finally {
		$ErrorActionPreference = $previous
	}

	return [pscustomobject]@{ Output = $output; ExitCode = $code }
}

function Test-NpmPackageAvailable {
	param([Parameter(Mandatory = $true)][string]$Name)

	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
		return $false
	}

	$result = Invoke-Native -Command 'npm' -Arguments @('view', $Name, 'version', '--silent')
	return ($result.ExitCode -eq 0)
}

$unknown = @($args | Where-Object { $_ -ne '-h' -and $_ -ne '--help' })
if ($unknown.Count -gt 0) {
	Write-Host "Unknown argument: $($unknown[0])" -ForegroundColor Red
	Write-Host ''
	Show-Usage
	exit 2
}
if ($args -contains '-h' -or $args -contains '--help') {
	Show-Usage
	exit 0
}

# Prefer the published npm package, but only when the registry actually has it.
# Fall back to the git source otherwise. Never guess.
$useOverride = -not [string]::IsNullOrWhiteSpace($env:VERBOO_PI_SOURCE)
if ($useOverride) {
	$source = $env:VERBOO_PI_SOURCE
}
elseif (Test-NpmPackageAvailable -Name ($NpmPackage -replace '^npm:', '')) {
	$source = $NpmPackage
}
else {
	$source = $GitSource
}

Write-Host "Resolved source: $source"
if (-not $useOverride -and $source -eq $GitSource) {
	Write-Host 'Could not resolve the npm package (registry unreachable or not published); using the git source instead.'
}

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
	Write-Host 'pi is not on PATH; installing Pi...'
	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
		Write-Host 'Error: pi is not installed and npm was not found. Install Node.js (which includes npm), then re-run this script.' -ForegroundColor Red
		exit 1
	}

	$install = Invoke-Native -Command 'npm' -Arguments @('install', '-g', '--ignore-scripts', $PiPackage)
	if ($install.ExitCode -ne 0) {
		Write-Host 'Error: failed to install Pi.' -ForegroundColor Red
		Write-Host $install.Output
		if ($install.Output -match 'EACCES|permission|Permission') {
			Write-Host 'Re-run with appropriate permissions (for example, configure a user-level npm prefix or use a Node version manager). Do not use sudo blindly.' -ForegroundColor Red
		}
		exit 1
	}
	Write-Host 'Pi installed.'
}

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
	Write-Host 'Error: Pi was installed but `pi` is still not on PATH. Add npm''s global bin directory to PATH and re-run this script.' -ForegroundColor Red
	exit 1
}

$install = Invoke-Native -Command 'pi' -Arguments @('install', $source)
if ($install.ExitCode -ne 0) {
	Write-Host "Error: `pi install $source` failed." -ForegroundColor Red
	Write-Host $install.Output
	exit 1
}
Write-Host $install.Output

Write-Host ''
Write-Host "Installed $source"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Set your Verboo API key:'
Write-Host '       $env:VERBOO_API_KEY = ''...'''
Write-Host '     Or run /login verboo inside pi to store a key instead.'
Write-Host '  2. List the models:'
Write-Host '       pi --list-models verboo'
Write-Host '  3. Select one inside pi with /model.'
