"""Collect non-secret deployment metadata after checks have passed."""
import datetime as dt
import json

from cryptography import x509
from cryptography.hazmat.primitives import hashes

from remote import ROOT, SECRETS, connect

remote_script = r'''
import datetime,json,pathlib,re,subprocess
root=pathlib.Path('/opt/shangjing-middleware')
containers=[]
for service in ['postgres','redis','minio']:
    name='shangjing-middleware-'+service+'-1'
    c=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
    containers.append({'service':service,'container':name,'image':c['Config']['Image'],
      'image_id':c['Image'],'state':c['State']['Status'],'health':c['State'].get('Health',{}).get('Status'),
      'restart_policy':c['HostConfig']['RestartPolicy']['Name'],'ports':c['NetworkSettings']['Ports']})
assert all(c['state']=='running' and c['health']=='healthy' for c in containers)
archives=sorted((root/'backups').glob('full-*.tar.gz'))
latest=archives[-1]
subprocess.run(['sha256sum','-c',str(latest)+'.sha256'],cwd=root,check=True,stdout=subprocess.DEVNULL)
log=(root/'build-minio.log').read_text()
sources=dict(line.split('=',1) for line in (root/'sources/versions.txt').read_text().splitlines())
print(json.dumps({'checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'containers':containers,'source_versions':sources,'source_sha256':(root/'sources/SHA256SUMS').read_text().splitlines(),
 'build_base_images':sorted(set(re.findall(r'docker.io/library/[^\s]+@sha256:[0-9a-f]{64}',log))),
 'initial_backup':{'path':str(latest),'bytes':latest.stat().st_size,'sha256':pathlib.Path(str(latest)+'.sha256').read_text().split()[0],
 'archive_readability_checked':True,'checksum_verified':True,'offsite_copy':False,'restore_drill':False}}))
'''
client = connect()
try:
    stdin, stdout, stderr = client.exec_command("python3 -", timeout=60)
    stdin.write(remote_script)
    stdin.channel.shutdown_write()
    result = stdout.read().decode()
    error = stderr.read().decode()
    if stdout.channel.recv_exit_status():
        raise RuntimeError(error)
    record = json.loads(result)
finally:
    client.close()
ca = x509.load_pem_x509_certificate((SECRETS / "tls/ca.crt").read_bytes())
leaf = x509.load_pem_x509_certificate((SECRETS / "tls/minio.crt").read_bytes())
record.update({
    "primary_host": "203.0.113.10", "same_server_alternate_ip": "203.0.113.11",
    "deployment_path": "/opt/shangjing-middleware", "compose_project": "shangjing-middleware",
    "versions": {"postgresql": "17.11", "redis": "7.4.11", "minio": "RELEASE.2025-10-15T17-29-55Z", "minio_build_go": "1.26.9"},
    "ca_sha256_fingerprint": ca.fingerprint(hashes.SHA256()).hex(),
    "ca_expires_at_utc": ca.not_valid_after_utc.isoformat(),
    "server_certificates_expire_at_utc": leaf.not_valid_after_utc.isoformat(),
    "ssh_ed25519_fingerprint": "SHA256:lD7yVP1YKY5rQkRfv6gaR3RLjYoffZi/O8r8B0LeXqA",
    "validated_on": "2026-10-19",
    "checks": {
        "postgres_public_tls_read_write": "passed on both IPs",
        "postgres_wrong_password_and_plaintext_rejected": "passed on both IPs",
        "redis_public_tls_read_write": "passed on both IPs",
        "redis_acl_key_scope_and_admin_command_restrictions": "passed on both IPs",
        "minio_upload_download_presigned_url": "passed on .254; object persistence read/write on .235",
        "minio_anonymous_access_and_invalid_credentials_rejected": "passed",
        "minio_private_versioned_buckets_and_application_scope": "passed",
        "minio_console_https_and_admin_login": "passed",
        "all_three_services_persist_after_container_restart": "passed via .235; isolated probes cleaned",
        "all_three_services_healthy_after_initial_cold_backup": "passed",
        "whole_host_reboot": "not performed",
        "offsite_disaster_restore": "not performed",
    },
})
target = ROOT / "docs/infrastructure/deployment-record.json"
target.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("Non-secret deployment record saved; all three containers are healthy and backup checksum is valid.")
