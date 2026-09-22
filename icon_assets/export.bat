SET inkscape=C:\Program Files\Inkscape\bin\inkscape
SET output_directory=..\public\images\ui

del "%output_directory%\*" /F /Q

"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="wad" --export-filename="%output_directory%\wad.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="users" --export-filename="%output_directory%\users.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="inspector" --export-filename="%output_directory%\inspector.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="textures" --export-filename="%output_directory%\textures.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="flats" --export-filename="%output_directory%\flats.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="things" --export-filename="%output_directory%\things.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="sounds" --export-filename="%output_directory%\sounds.png"

"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="select_mode" --export-filename="%output_directory%\select_mode.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="line_mode" --export-filename="%output_directory%\line_mode.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="rectangle_mode" --export-filename="%output_directory%\rectangle_mode.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="ellipse_mode" --export-filename="%output_directory%\ellipse_mode.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="extrude_mode" --export-filename="%output_directory%\extrude_mode.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="thing_mode" --export-filename="%output_directory%\thing_mode.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="slope_mode" --export-filename="%output_directory%\slope_mode.png"

"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="mini_window__enabled" --export-filename="%output_directory%\mini_window__enabled.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="mini_window__disabled" --export-filename="%output_directory%\mini_window__disabled.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="mini_window__swap" --export-filename="%output_directory%\mini_window__swap.png"

"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="show_textures__enabled" --export-filename="%output_directory%\show_textures__enabled.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="show_textures__disabled" --export-filename="%output_directory%\show_textures__disabled.png"

"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="shortcuts__enabled" --export-filename="%output_directory%\shortcuts__enabled.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="shortcuts__disabled" --export-filename="%output_directory%\shortcuts__disabled.png"

"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="undo" --export-filename="%output_directory%\undo.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="redo" --export-filename="%output_directory%\redo.png"

"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="run" --export-filename="%output_directory%\run.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="vr" --export-filename="%output_directory%\vr.png"
"%inkscape%" ui.svg --export-area-drawing --export-type="png" --export-id-only --export-id="xr" --export-filename="%output_directory%\xr.png"

pause
