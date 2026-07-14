"""Generate simple DOI Grabber icons (red circle with 'D')."""
import struct, zlib, os

def make_png(size):
    def chunk(tag, data):
        c = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", c)

    img = []
    for y in range(size):
        row = [0]  # filter byte
        for x in range(size):
            cx, cy = x - size/2, y - size/2
            r = (cx**2 + cy**2) ** 0.5
            margin = size * 0.05
            if r <= size/2 - margin:
                # dark circle
                row += [30, 30, 30, 255]
            else:
                row += [0, 0, 0, 0]
        img.append(bytes(row))

    raw = b"".join(img)
    compressed = zlib.compress(raw)
    ihdr_data = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    # RGBA
    ihdr_data = struct.pack(">II", size, size) + bytes([8, 6, 0, 0, 0])
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr_data)
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")
    return png

os.makedirs("doi-extension/extension/icons", exist_ok=True)
for size in [16, 48, 128]:
    with open(f"doi-extension/extension/icons/icon{size}.png", "wb") as f:
        f.write(make_png(size))
print("Icons written.")
