# Certificates

**Nothing in this directory is committed.** `.gitignore` excludes `certs/*`
except this README, and additionally excludes `*.pem`, `*.key` and `*.crt`
anywhere in the repository.

The simulator, the MQTT tap and the bridge use **MQTT over TLS 1.2 with mutual
X.509 authentication** when `MQTT_MODE=aws`. AWS IoT Core authenticates the
client by its certificate; there is no username or password.

## Files expected here

| File | What it is | Where it comes from |
|---|---|---|
| `AmazonRootCA1.pem` | Amazon root CA, used to verify the broker | <https://www.amazontrust.com/repository/AmazonRootCA1.pem> |
| `device-certificate.pem.crt` | This client's certificate | AWS IoT console or `aws iot create-keys-and-certificate` |
| `device-private.pem.key` | This client's private key | Same command - **downloadable only once** |

## Creating them

```bash
aws iot create-keys-and-certificate \
  --set-as-active \
  --certificate-pem-outfile certs/device-certificate.pem.crt \
  --public-key-outfile certs/device-public.pem.key \
  --private-key-outfile certs/device-private.pem.key
```

Then attach an IoT policy that allows only what this project needs (connect,
publish to `transport/raw/*`, subscribe to `transport/normalized/*`) - see
`docs/AWS_DEPLOYMENT.md`.

Record the resulting paths in `.env`:

```
AWS_IOT_CA_PATH=certs/AmazonRootCA1.pem
AWS_IOT_CERT_PATH=certs/device-certificate.pem.crt
AWS_IOT_PRIVATE_KEY_PATH=certs/device-private.pem.key
```

## Rules

- Never commit these files, and never paste their contents into `.env`,
  documentation, source code or an issue.
- Never copy them into a Docker image - the `.dockerignore` excludes `certs/`.
- If a private key is ever exposed, deactivate and delete that certificate in
  AWS IoT and create a new one.
- The application never logs certificate contents; it logs paths only.
