param(
  [string]$Target = "awesomechurch@192.168.2.18",
  [string]$RemoteDirectory = "/home/awesomechurch/photowall"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$transcript = Join-Path $root "deployment.log"
$progressPath = Join-Path $root ".deploy-progress.json"

Set-Location $root
Start-Transcript -Path $transcript -Force | Out-Null

try {
  $progress = if (Test-Path $progressPath) {
    Get-Content -Raw $progressPath | ConvertFrom-Json
  } else {
    [pscustomobject]@{
      projectCompleted = 0
      mediaCompleted = 0
    }
  }

  function Save-Progress {
    $progress | ConvertTo-Json | Set-Content -Path $progressPath -Encoding UTF8
  }

  function Copy-FileWithRetry {
    param(
      [string]$LocalPath,
      [string]$RemotePath,
      [string]$Label
    )

    for ($attempt = 1; $attempt -le 3; $attempt++) {
      & scp.exe -O -o ConnectTimeout=15 $LocalPath "${Target}:$RemotePath"
      if ($LASTEXITCODE -eq 0) {
        return
      }
      if ($attempt -lt 3) {
        Write-Host "Connection dropped. Retrying $Label (attempt $($attempt + 1) of 3)..."
      }
    }

    throw "Upload failed after 3 attempts: $Label"
  }

  Write-Host "Creating remote project folders..."
  & ssh.exe -o ConnectTimeout=15 $Target `
    "mkdir -p '$RemoteDirectory' '$RemoteDirectory/media/photos' '$RemoteDirectory/media/photo-slides' '$RemoteDirectory/media/slides'"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create the remote project folders."
  }

  $projectFiles = Get-ChildItem -Path $root -File | Where-Object {
    $_.Name -notlike "*.log" -and
    $_.Name -ne ".signage-sync-state.json" -and
    $_.Name -ne ".deploy-progress.json"
  }

  Write-Host ""
  Write-Host "Copying $($projectFiles.Count) project files one at a time..."
  for ($index = 0; $index -lt $projectFiles.Count; $index++) {
    $file = $projectFiles[$index]
    if ($index -lt [int]$progress.projectCompleted) {
      Write-Host "Already copied: $($file.Name)"
      continue
    }

    Write-Host ""
    Write-Host "Project file $($index + 1) of $($projectFiles.Count): $($file.Name)"
    Copy-FileWithRetry $file.FullName "$RemoteDirectory/" $file.Name
    $progress.projectCompleted = $index + 1
    Save-Progress
  }

  $mediaDirectories = @(
    @{ Local = Join-Path $root "media\photos"; Remote = "$RemoteDirectory/media/photos" },
    @{ Local = Join-Path $root "media\photo-slides"; Remote = "$RemoteDirectory/media/photo-slides" },
    @{ Local = Join-Path $root "media\slides"; Remote = "$RemoteDirectory/media/slides" }
  )

  $mediaTransfers = @()
  foreach ($directory in $mediaDirectories) {
    if (-not (Test-Path $directory.Local)) {
      continue
    }

    foreach ($file in Get-ChildItem -Path $directory.Local -File) {
      $mediaTransfers += [pscustomobject]@{
        File = $file
        Remote = "$($directory.Remote)/"
      }
    }
  }

  Write-Host ""
  Write-Host "Copying $($mediaTransfers.Count) media files one at a time..."
  for ($index = 0; $index -lt $mediaTransfers.Count; $index++) {
    $transfer = $mediaTransfers[$index]
    if ($index -lt [int]$progress.mediaCompleted) {
      Write-Host "Already copied: $($transfer.File.Name)"
      continue
    }

    Write-Host ""
    Write-Host "Media file $($index + 1) of $($mediaTransfers.Count): $($transfer.File.Name)"
    Copy-FileWithRetry $transfer.File.FullName $transfer.Remote $transfer.File.Name
    $progress.mediaCompleted = $index + 1
    Save-Progress
  }

  Write-Host ""
  Write-Host "Starting signage on the VM..."
  & ssh.exe -o ConnectTimeout=15 $Target `
    "cd '$RemoteDirectory' && chmod +x start_signage.sh && bash -n start_signage.sh && ./start_signage.sh"
  if ($LASTEXITCODE -ne 0) {
    throw "Remote startup failed."
  }

  Write-Host ""
  Write-Host "Deployment complete: http://192.168.2.18:8000/"
  Remove-Item -LiteralPath $progressPath -Force -ErrorAction SilentlyContinue
} catch {
  Write-Error $_
  exit 1
} finally {
  Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
