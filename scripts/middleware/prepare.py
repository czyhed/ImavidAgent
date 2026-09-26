"""Prepare an isolated deployment. Never print credentials."""
import datetime as dt
import hashlib
import ipaddress
import json
from pathlib import Path
import secrets
import shlex

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

from remote import ROOT, SECRETS, connect, client_ca_path

DEST = "/opt/shangjing-middleware"
CERTS = SECRETS / "tls"


def make_certificates():
    CERTS.mkdir(parents=True, exist_ok=True)
    if (CERTS / "ca.crt").exists():
        for name in ("ca.key", "postgres.crt", "postgres.key", "redis.crt", "redis.key", "minio.crt", "minio.key"):
            if not (CERTS / name).exists():
                raise RuntimeError(f"Incomplete certificate set: {name}")
        return
    now = dt.datetime.now(dt.timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Shangjing Test Middleware CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - dt.timedelta(minutes=10)).not_valid_after(now + dt.timedelta(days=3650))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                      data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                                      encipher_only=False, decipher_only=False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    (CERTS / "ca.crt").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (CERTS / "ca.key").write_bytes(ca_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    for name in ("postgres", "redis", "minio"):
        key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        cert = (x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"Shangjing {name}")]))
                .issuer_name(ca_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - dt.timedelta(minutes=10)).not_valid_after(now + dt.timedelta(days=365))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.SubjectAlternativeName([
                    x509.IPAddress(ipaddress.ip_address("203.0.113.11")),
                    x509.IPAddress(ipaddress.ip_address("203.0.113.10")),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                    x509.DNSName("localhost"), x509.DNSName(name)]), critical=False)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=True,
                                            data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                                            encipher_only=False, decipher_only=False), critical=True)
                .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
                .sign(ca_key, hashes.SHA256()))
        (CERTS / f"{name}.crt").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (CERTS / f"{name}.key").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


def run(client, command):
    _, stdout, stderr = client.exec_command(command, timeout=60)
    out, err = stdout.read().decode(), stderr.read().decode()
    if stdout.channel.recv_exit_status():
        raise RuntimeError(err or out)
    return out


def main():
    credential_file = SECRETS / "middleware-admin.json"
    if credential_file.exists():
        credentials = json.loads(credential_file.read_text())
    else:
        credentials = {name: secrets.token_urlsafe(32) for name in (
            "POSTGRES_ADMIN_PASSWORD", "POSTGRES_APP_PASSWORD", "REDIS_ADMIN_PASSWORD",
            "REDIS_APP_PASSWORD", "MINIO_ADMIN_PASSWORD", "MINIO_APP_PASSWORD")}
        credential_file.write_text(json.dumps(credentials, indent=2), encoding="utf-8")
    make_certificates()
    client_ca = client_ca_path()
    image_env = {
        "POSTGRES_IMAGE": "postgres@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826",
        "REDIS_IMAGE": "redis@sha256:4fa24486b8bcca8eec45ee0eb166edc674795e53a2b53d1a9ef263eecebaac85",
        "MINIO_IMAGE": "shangjing/minio:RELEASE.2025-10-15T17-29-55Z",
    }
    env_content = "".join(f"{k}={v}\n" for k, v in {**image_env, **credentials}.items())
    app = {
        "PGHOST": "203.0.113.10", "PGPORT": "5432", "PGDATABASE": "shangjing", "PGUSER": "shangjing_app",
        "PGPASSWORD": credentials["POSTGRES_APP_PASSWORD"], "PGSSLMODE": "verify-full",
        "PGSSLROOTCERT": client_ca.as_posix(),
        "DATABASE_URL": f"postgresql://shangjing_app:{credentials['POSTGRES_APP_PASSWORD']}@203.0.113.10:5432/shangjing?sslmode=verify-full",
        "REDIS_URL": f"rediss://shangjing_app:{credentials['REDIS_APP_PASSWORD']}@203.0.113.10:6379/0",
        "REDIS_USERNAME": "shangjing_app", "REDIS_PASSWORD": credentials["REDIS_APP_PASSWORD"],
        "REDIS_KEY_PREFIX": "sj:", "MIDDLEWARE_CA_CERT": client_ca.as_posix(),
        "NODE_EXTRA_CA_CERTS": client_ca.as_posix(),
        "MINIO_ENDPOINT": "https://203.0.113.10:9000", "MINIO_REGION": "us-east-1",
        "MINIO_ACCESS_KEY": "shangjing_app", "MINIO_SECRET_KEY": credentials["MINIO_APP_PASSWORD"],
        "MINIO_BUCKET_ASSETS": "shangjing-assets", "MINIO_BUCKET_EXPORTS": "shangjing-exports",
    }
    (ROOT / ".env.middleware.local").write_text("".join(f'{k}="{v}"\n' for k, v in app.items()), encoding="utf-8")
    acl = ("user default off\n"
           f"user admin on #{hashlib.sha256(credentials['REDIS_ADMIN_PASSWORD'].encode()).hexdigest()} ~* &* +@all\n"
           f"user shangjing_app on #{hashlib.sha256(credentials['REDIS_APP_PASSWORD'].encode()).hexdigest()} ~sj:* &sj:* +@all "
           "-config -acl -shutdown -module -flushall -flushdb -debug -replicaof -slaveof -migrate\n")
    client = connect()
    try:
        run(client, f"if test -d {DEST} && ! test -f {DEST}/.shangjing-managed; then echo 'Existing unmanaged directory' >&2; exit 1; fi; mkdir -p {DEST}; chmod 700 {DEST}; touch {DEST}/.shangjing-managed")
        sftp = client.open_sftp()
        try:
            try:
                with sftp.open(f"{DEST}/.env") as f:
                    if f.read().decode() != env_content:
                        raise RuntimeError("Remote .env differs; refusing credential overwrite")
            except FileNotFoundError:
                pass
            directories = ["postgres", "redis", "tls/postgres", "tls/redis", "tls/minio/CAs", "tls/authority", "data/postgres", "data/redis", "data/minio", "sources", "backups"]
            run(client, "mkdir -p " + " ".join(shlex.quote(f"{DEST}/{d}") for d in directories))
            def put_bytes(name, data, mode=0o600):
                with sftp.open(f"{DEST}/{name}", "wb") as f:
                    f.write(data)
                sftp.chmod(f"{DEST}/{name}", mode)
            for p in (ROOT / "infra/middleware").rglob("*"):
                if p.is_file():
                    put_bytes(p.relative_to(ROOT / "infra/middleware").as_posix(), p.read_bytes(), 0o644)
            put_bytes(".env", env_content.encode())
            put_bytes("redis/users.acl", acl.encode(), 0o644)
            for name in ("postgres", "redis"):
                put_bytes(f"tls/{name}/server.crt", (CERTS / f"{name}.crt").read_bytes(), 0o644)
                put_bytes(f"tls/{name}/server.key", (CERTS / f"{name}.key").read_bytes(), 0o600)
                put_bytes(f"tls/{name}/ca.crt", (CERTS / "ca.crt").read_bytes(), 0o644)
            put_bytes("tls/minio/public.crt", (CERTS / "minio.crt").read_bytes(), 0o644)
            put_bytes("tls/minio/private.key", (CERTS / "minio.key").read_bytes(), 0o600)
            put_bytes("tls/minio/CAs/ca.crt", (CERTS / "ca.crt").read_bytes(), 0o644)
            put_bytes("tls/authority/ca.key", (CERTS / "ca.key").read_bytes())
            put_bytes("tls/authority/ca.crt", (CERTS / "ca.crt").read_bytes(), 0o644)
            run(client, f"chown -R 999:999 {DEST}/tls/postgres {DEST}/tls/redis; chown -R 10001:10001 {DEST}/tls/minio; chown 999:999 {DEST}/data/postgres {DEST}/data/redis; chown 10001:10001 {DEST}/data/minio; chmod 700 {DEST}/data/postgres; cd {DEST}; docker compose config --quiet")
        finally:
            sftp.close()
        print("Deployment files, independent credentials, and TLS certificates prepared; no secrets printed.")
    finally:
        client.close()


if __name__ == "__main__":
    main()
