import os
import subprocess
import run_test

pages = [
    "./pages/index.html",
    "./pages/testDbSearch.html",
    "./pages/testRtcConnector.html"
]


for page in pages:
    env = run_test.load_test_env("./test_net_env")
    env["PAGE_OUT_DIR_ABS"] = os.path.abspath(env["PAGE_OUT_DIR"])
    env["PAGE"] = page
    subprocess.run(["npx", "vite", "build"], env=env, check=True)