' Starts run-tracker.cmd with no console window (window style 0) and waits
' for it to finish, so the scheduled task can't be stopped by closing a
' window. Chrome windows for VRBO and Booking.com still appear as normal.
' To stop a run: Task Scheduler > OTA Rank Tracker > End.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "cmd.exe /c """ & here & "\run-tracker.cmd""", 0, True
