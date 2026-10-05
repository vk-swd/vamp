#!/usr/bin/env python3
import argparse
import json
import os
import subprocess

COMPOSE_ENV_FILE = "./test/yamls/.env"

WRTC_ENV_FILES = [
    "test/yamls/services/vps_front.yaml",
    "test/yamls/services/sigturn.yaml",
    "test/yamls/services/nat_backend.yaml",
    "test/yamls/services/backend.yaml",
    "test/yamls/services/nat_b1.yaml",
    "test/yamls/services/nat_b2.yaml",
    "test/yamls/services/browser.yaml",
    "test/yamls/networks.yaml",
    "test/yamls/volumes.yaml",
    "test/yamls/misc/test_builder.yaml",
    "test/yamls/module_orchestrator.yaml",
]


def load_test_env(filename, env=None):
    if env is None:
        env = os.environ.copy()
    with open(filename, encoding="utf-8") as file:
        test_values = json.load(file)
    env.update({key: str(value) for key, value in test_values.items()})
    return env


def test_wrtc():
    env = load_test_env("./test_net_env")
    cmd = ["docker", "compose"]
    for f in WRTC_ENV_FILES:
        cmd += ["-f", "./" + f]
    subprocess.run(cmd + ["stop", "-t", "0"], check=True, env=env)
    subprocess.run(cmd + ["up", "-d"], check=True, env=env)


def test_handle():
    env = load_test_env("./test_net_env")
    load_test_env("./test/yamls/.env", env)
    env["PUPPETEER_FILES_DIR"] = os.path.abspath("test/tests/rtc/pptr_files")
    env["PUPPETEER_PAGE_NAME"] = "testDbSearch.html"
    env["PAGE_OUT_DIR_ABS"] = os.path.abspath(env["PAGE_OUT_DIR"])
    env["TEST_BIN"] = os.path.abspath("src-tauri/target/debug/select_test")
    env.update({
        "SS_HOST": "127.0.0.1"
    })

    cmd = ["docker", "compose"]
    cmd += ["-f", "test/yamls/tests/browser_local.yaml"]
    subprocess.run(cmd + ["stop", "-t", "0"], check=True, env=env)
    subprocess.run(cmd + ["up", "--abort-on-container-exit",
                          "--exit-code-from", "browser_local"], check=True, env=env)


TESTS = {
    "wrtc": test_wrtc,
    "handle": test_handle,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-t", "--test", choices=TESTS, default="wrtc")
    args = parser.parse_args()
    TESTS[args.test]()


if __name__ == "__main__":
    main()