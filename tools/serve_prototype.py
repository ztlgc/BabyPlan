"""只在本机提供静态原型文件；不包含API或上传能力。"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser(description="在本机提供BabyPlan静态原型；不包含API。")
parser.add_argument("--port", type=int, default=4173, help="本机监听端口（默认4173）")
parser.add_argument("--surface", choices=("mobile", "all"), default="mobile", help="mobile为原安卓入口，all为三端总入口")
args = parser.parse_args()
folder = Path(__file__).resolve().parents[1] / "prototype"
if args.surface == "mobile":
    folder /= "mobile"


class PrototypeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # 本地评审总是读取最新源码，避免改动被浏览器缓存遮住。
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


handler = partial(PrototypeHandler, directory=str(folder))
server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
print(f"BabyPlan prototype: http://127.0.0.1:{args.port}", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
