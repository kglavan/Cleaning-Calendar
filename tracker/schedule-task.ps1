# Registers a Windows scheduled task that runs the rank tracker on weekdays.
# Usage (from the tracker folder):  powershell -ExecutionPolicy Bypass -File .\schedule-task.ps1 -Time 9:00am
# It runs only while you're logged in, because VRBO and Booking.com need a
# visible Chrome window. It runs with no console window (via run-hidden.vbs),
# so it can't be stopped by closing one; stop a run from Task Scheduler.
# Remove it with:  schtasks /Delete /TN "OTA Rank Tracker" /F
param(
  [string]$Time = "9:00am",
  [string[]]$Days = @("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")
)

$launcher = Join-Path $PSScriptRoot "run-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //Nologo `"$launcher`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Days -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName "OTA Rank Tracker" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Scheduled 'OTA Rank Tracker' at $Time on $($Days -join ', '), with no console window. Output goes to tracker\tracker.log."
