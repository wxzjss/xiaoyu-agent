Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap(1749, 1034)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(0, 0, 0, 0, [System.Drawing.Size]::new(1749, 1034))
$b.Save('D:\小鱼Agent\_t_scr.png')
$g.Dispose()
$b.Dispose()
