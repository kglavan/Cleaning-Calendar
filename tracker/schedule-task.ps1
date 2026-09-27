# Registers a daily Windows scheduled task that runs the rank tracker.
# Usage (from the tracker folder):  powershell -ExecutionPolicy Bypass -File .\schedule-task.ps1 -Time 7:30am
# It runs only while you're logged in, because VRBO and Booking.com need a
# visible Chrome window. Remove it with:  schtasks /Delete /TN "OTA Rank Tracker" /F
param([string]$Time = "7:30am")

$cmd = Join-Path $PSScriptRoot "run-tracker.cmd"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$cmd`""
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName "OTA Rank Tracker" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Scheduled 'OTA Rank Tracker' daily at $Time. Output goes to tracker\tracker.log."
