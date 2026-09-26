"""Run a command on the test server; credentials stay in ignored local files."""
import argparse
import base64
import hashlib
import json
import os
import socket
from pathlib import Path
import sys

import paramiko

# Windows 控制台默认 GBK，远端 UTF-8 日志（如构建符号）不能让它中断传输。
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
SECRETS = ROOT / ".secrets"


def client_ca_path():
    source = SECRETS / "tls/ca.crt"
    if os.name != "nt":
        return source
    # Windows libpq may not open a certificate through a non-ASCII project path.
    target = Path(os.environ["LOCALAPPDATA"]) / "Shangjing/middleware/ca.crt"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(source.read_bytes())
    return target


def current_interface_address(index):
    """Return the current IPv4 of a Windows interface index, or None."""
    if os.name != "nt" or index is None:
        return None
    import subprocess
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-NetIPAddress -InterfaceIndex {int(index)} -AddressFamily IPv4 -ErrorAction Stop).IPAddress"],
            capture_output=True, text=True, timeout=20).stdout.split()
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return next((ip for ip in out if not ip.startswith("169.254.")), None)


def connect():
    config = json.loads((SECRETS / "server.json").read_text(encoding="utf-8"))
    client = paramiko.SSHClient()
    host_file = SECRETS / "known_hosts"
    if host_file.exists():
        client.load_host_keys(str(host_file))
    else:
        host_file.touch()
        client.load_host_keys(str(host_file))
    if not client.get_host_keys().lookup(config["host"]):
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    transport_socket = None
    if config.get("interface_index") is not None or config.get("source_address"):
        transport_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        transport_socket.settimeout(20)
        if config.get("interface_index") is not None:
            transport_socket.setsockopt(socket.IPPROTO_IP, 31, socket.htonl(config["interface_index"]))
        if config.get("source_address"):
            try:
                transport_socket.bind((config["source_address"], 0))
            except OSError:
                # 换网络后地址会变：按配置的网卡索引查当前 IPv4，再绑定。
                current = current_interface_address(config.get("interface_index"))
                if not current:
                    raise
                transport_socket.bind((current, 0))
        transport_socket.connect((config["host"], config.get("port", 22)))
    client.connect(config["host"], port=config.get("port", 22), username=config["username"],
                   password=config["password"], timeout=20, banner_timeout=20,
                   auth_timeout=20, look_for_keys=False, allow_agent=False, sock=transport_socket)
    key = client.get_transport().get_remote_server_key()
    fingerprint = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")
    print(f"SSH host key: {key.get_name()} SHA256:{fingerprint}", flush=True)
    return client


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?")
    parser.add_argument("--script", type=Path)
    parser.add_argument(
        "--put", nargs=2, metavar=("LOCAL", "REMOTE"),
        help="upload a local file over SFTP without printing its contents",
    )
    parser.add_argument(
        "--get", nargs=2, metavar=("REMOTE", "LOCAL"),
        help="download a remote file over SFTP without printing its contents",
    )
    args = parser.parse_args()
    command = args.script.read_text(encoding="utf-8-sig") if args.script else args.command
    if not command and not args.put and not args.get:
        parser.error("provide command, --script, --put or --get")
    client = connect()
    try:
        if args.put or args.get:
            sftp = client.open_sftp()
            try:
                if args.put:
                    local, remote = (Path(args.put[0]), args.put[1])
                    sftp.put(str(local), remote)
                    print(f"uploaded {local.name} -> {remote}")
                if args.get:
                    remote, local = (args.get[0], Path(args.get[1]))
                    sftp.get(remote, str(local))
                    print(f"downloaded {remote} -> {local.name}")
            finally:
                sftp.close()
            if not command:
                return 0
        stdin, stdout, stderr = client.exec_command("bash -s", timeout=1800)
        stdin.write(command + "\n")
        stdin.channel.shutdown_write()
        for line in stdout:
            print(line, end="", flush=True)
        error = stderr.read().decode(errors="replace")
        if error:
            print(error, file=sys.stderr, end="")
        return stdout.channel.recv_exit_status()
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
