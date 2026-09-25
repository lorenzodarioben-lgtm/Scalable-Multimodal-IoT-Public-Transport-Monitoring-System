import { createHash, createHmac } from 'node:crypto';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { SignatureV4 } from '@smithy/signature-v4';

class Sha256 {
  constructor(secret) {
    this.hash = secret ? createHmac('sha256', secret) : createHash('sha256');
  }
  update(bytes) { this.hash.update(bytes); }
  digest() { return Promise.resolve(this.hash.digest()); }
}

const credentials = fromIni({ profile: 'academy' });
const body = 'Action=GetCallerIdentity&Version=2011-06-15';
const signer = new SignatureV4({ credentials, region: 'us-east-1', service: 'sts', sha256: Sha256 });
const signed = await signer.sign({
  method: 'POST', protocol: 'https:', hostname: 'sts.us-east-1.amazonaws.com', path: '/',
  headers: { host: 'sts.us-east-1.amazonaws.com', 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  body,
});
const response = await fetch('https://sts.us-east-1.amazonaws.com/', {
  method: 'POST', headers: signed.headers, body,
});
const xml = await response.text();
if (!response.ok) throw new Error(`STS GetCallerIdentity failed: HTTP ${response.status}: ${xml.replace(/<[^>]*>/g, ' ').trim()}`);
const value = (name) => xml.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1] ?? null;
const identity = { Account: value('Account'), Arn: value('Arn'), UserId: value('UserId'), Region: 'us-east-1' };
if (!identity.Account || !identity.Arn || !identity.UserId) throw new Error('STS response omitted identity fields');
console.log(JSON.stringify(identity, null, 2));
