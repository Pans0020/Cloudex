"""Regenerate the visible animation fixture: uv run --with pillow python test/generate-preview-gif.py."""
from pathlib import Path
from PIL import Image, ImageDraw

frames = []
for label, color in (("FRAME A", "#126154"), ("FRAME B", "#375f94")):
    frame = Image.new("RGB", (240, 160), color)
    ImageDraw.Draw(frame).text((80, 75), label, fill="white")
    frames.append(frame)
frames[0].save(Path(__file__).parent / "fixtures" / "preview.gif", save_all=True,
               append_images=frames[1:], duration=600, loop=0, disposal=2)
