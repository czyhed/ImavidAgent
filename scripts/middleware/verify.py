"""Verify public TLS connections; probes use isolated, disposable names."""
import argparse
import json
import ssl
import urllib.error
import urllib.request
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
import psycopg
from psycopg import sql
import redis

from remote import SECRETS, client_ca_path

CREDENTIALS = json.loads((SECRETS / "middleware-admin.json").read_text())
CA = str(client_ca_path())
STATE = SECRETS / "verification-state.json"


def pg(host, **extra):
    options = dict(host=host, port=5432, dbname="shangjing", user="shangjing_app",
                   password=CREDENTIALS["POSTGRES_APP_PASSWORD"], sslmode="verify-full",
                   sslrootcert=CA, connect_timeout=10)
    options.update(extra)
    return psycopg.connect(**options)


def redis_client(host, **extra):
    options = dict(host=host, port=6379, username="shangjing_app", password=CREDENTIALS["REDIS_APP_PASSWORD"],
                   ssl=True, ssl_ca_certs=CA, ssl_check_hostname=True, socket_timeout=10, socket_connect_timeout=10)
    options.update(extra)
    return redis.Redis(**options)


def s3(host, admin=False, **extra):
    options = dict(endpoint_url=f"https://{host}:9000", region_name="us-east-1", verify=CA,
                   aws_access_key_id="sj_minio_admin" if admin else "shangjing_app",
                   aws_secret_access_key=CREDENTIALS["MINIO_ADMIN_PASSWORD" if admin else "MINIO_APP_PASSWORD"],
                   config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                                 connect_timeout=10, read_timeout=15, retries={"max_attempts": 1}))
    options.update(extra)
    return boto3.client("s3", **options)


def http(url, data=None):
    return urllib.request.urlopen(urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}),
                                  context=ssl.create_default_context(cafile=CA), timeout=15)


def smoke(host, services):
    if "postgres" in services:
        with pg(host) as conn:
            row = conn.execute("SELECT current_user, current_database(), current_setting('server_version'), (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()), (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)").fetchone()
            assert row[0] == "shangjing_app" and row[1] == "shangjing" and row[3] and not row[4]
            conn.execute("CREATE TEMP TABLE middleware_smoke(value text)")
            conn.execute("INSERT INTO middleware_smoke VALUES (%s)", ("verified",))
            assert conn.execute("SELECT value FROM middleware_smoke").fetchone()[0] == "verified"
        try:
            pg(host, password="intentionally-invalid-probe-password")
            raise AssertionError("Invalid PostgreSQL password accepted")
        except psycopg.OperationalError as e:
            assert "password authentication failed" in str(e), str(e)
        try:
            pg(host, sslmode="disable")
            raise AssertionError("Plaintext PostgreSQL accepted")
        except psycopg.OperationalError as e:
            assert "no encryption" in str(e), str(e)
        print(f"PostgreSQL {host}: TLS, app read/write, least privilege, invalid password and plaintext rejection PASS; version {row[2]}")
    if "redis" in services:
        r = redis_client(host)
        key = "sj:infra-smoke:" + uuid.uuid4().hex
        try:
            assert r.ping() and r.set(key, "verified", ex=120) and r.get(key) == b"verified"
        finally:
            r.delete(key)
        for action in (lambda: r.get("outside-project:probe"), lambda: r.config_get("maxmemory")):
            try:
                action()
                raise AssertionError("Redis scope restriction missing")
            except redis.exceptions.NoPermissionError:
                pass
        try:
            redis_client(host, password="intentionally-invalid-probe-password").ping()
            raise AssertionError("Invalid Redis password accepted")
        except redis.exceptions.AuthenticationError:
            pass
        print(f"Redis {host}: TLS, app read/write, key scope and admin restrictions PASS; version {r.info('server')['redis_version']}")
    if "minio" in services:
        client = s3(host)
        key = "__infra_probe/" + uuid.uuid4().hex + ".txt"
        response = client.put_object(Bucket="shangjing-assets", Key=key, Body=b"verified", ContentType="text/plain")
        try:
            assert client.get_object(Bucket="shangjing-assets", Key=key)["Body"].read() == b"verified"
            signed_url = client.generate_presigned_url("get_object", Params={"Bucket": "shangjing-assets", "Key": key}, ExpiresIn=60)
            with http(signed_url) as result:
                assert result.read() == b"verified"
            try:
                http(f"https://{host}:9000/shangjing-assets/{key}")
                raise AssertionError("Anonymous object read allowed")
            except urllib.error.HTTPError as e:
                assert e.code == 403
            try:
                s3(host, aws_secret_access_key="intentionally-invalid-probe-password").head_bucket(Bucket="shangjing-assets")
                raise AssertionError("Invalid MinIO password accepted")
            except ClientError as e:
                assert e.response["ResponseMetadata"]["HTTPStatusCode"] == 403
            assert {b["Name"] for b in client.list_buckets()["Buckets"]} <= {"shangjing-assets", "shangjing-exports"}
            denied_bucket = "shangjing-denied-probe-" + uuid.uuid4().hex
            try:
                client.create_bucket(Bucket=denied_bucket)
            except ClientError as e:
                assert e.response["ResponseMetadata"]["HTTPStatusCode"] == 403
            else:
                s3(host, admin=True).delete_bucket(Bucket=denied_bucket)
                raise AssertionError("MinIO app can create buckets")
            for bucket in ["shangjing-assets", "shangjing-exports"]:
                client.head_bucket(Bucket=bucket)
                assert s3(host, admin=True).get_bucket_versioning(Bucket=bucket)["Status"] == "Enabled"
            with http(f"https://{host}:9000/minio/health/live") as result:
                assert result.status == 200
            with http(f"https://{host}:9001/") as result:
                assert result.status == 200 and b"<html" in result.read().lower()
            with http(f"https://{host}:9001/api/v1/login", json.dumps({"accessKey": "sj_minio_admin", "secretKey": CREDENTIALS["MINIO_ADMIN_PASSWORD"]}).encode()) as result:
                assert result.status in (200, 204)
        finally:
            s3(host, admin=True).delete_object(Bucket="shangjing-assets", Key=key, VersionId=response["VersionId"])
        print(f"MinIO {host}: TLS, upload/download, signed URL, private buckets, versioning, restricted app account, console login PASS")


def persistence(host, mode):
    if mode == "seed":
        if STATE.exists():
            raise RuntimeError("Existing persistence probe; check and clean it before reseeding")
        token = uuid.uuid4().hex
        state = {"token": token, "table": "_infra_probe_" + token, "key": "sj:infra-probe:" + token,
                 "object": "__infra_probe/" + token + ".txt"}
        STATE.write_text(json.dumps(state), encoding="utf-8")
        with pg(host) as conn:
            conn.execute(sql.SQL("CREATE TABLE {} (value text NOT NULL)").format(sql.Identifier(state["table"])))
            conn.execute(sql.SQL("INSERT INTO {} VALUES (%s)").format(sql.Identifier(state["table"])), (token,))
        redis_client(host).set(state["key"], token)
        result = s3(host).put_object(Bucket="shangjing-assets", Key=state["object"], Body=token.encode())
        state["version"] = result["VersionId"]
        STATE.write_text(json.dumps(state), encoding="utf-8")
        print("Persistence probes seeded; restart only the shangjing-middleware containers next.")
    else:
        state = json.loads(STATE.read_text())
        with pg(host) as conn:
            assert conn.execute(sql.SQL("SELECT value FROM {}").format(sql.Identifier(state["table"]))).fetchone()[0] == state["token"]
        assert redis_client(host).get(state["key"]) == state["token"].encode()
        assert s3(host).get_object(Bucket="shangjing-assets", Key=state["object"])["Body"].read() == state["token"].encode()
        with pg(host) as conn:
            conn.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(state["table"])))
        redis_client(host).delete(state["key"])
        s3(host, admin=True).delete_object(Bucket="shangjing-assets", Key=state["object"], VersionId=state["version"])
        STATE.unlink()
        print("PostgreSQL, Redis, MinIO persistence across container restart PASS; isolated probes cleaned.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="203.0.113.10")
    parser.add_argument("--services", nargs="+", choices=["postgres", "redis", "minio"], default=["postgres", "redis", "minio"])
    parser.add_argument("--mode", choices=["smoke", "seed", "check-cleanup"], default="smoke")
    args = parser.parse_args()
    if args.mode == "smoke":
        smoke(args.host, args.services)
    else:
        persistence(args.host, args.mode)
