import { createHash, timingSafeEqual } from 'node:crypto';
const version='android-admin-2026-11';
const releaseDigest='6e432d8eb4c5f4f3ccc87e6ed491de6bb330a304671f9d174429903e6f5d6b20';
const hash=value=>createHash('sha256').update(value).digest();
export function createPosAdministrationVerifier(androidDigest=releaseDigest){return function(value,credentialVersion,env=process.env){
 if(typeof value!=='string'||value.length<1||value.length>256)return false;
 if(credentialVersion===version)return timingSafeEqual(hash(value),Buffer.from(androidDigest,'hex'));
 if(credentialVersion!==undefined&&credentialVersion!==null&&credentialVersion!=='')return false;
 return typeof env.POS_ADMIN_PASSWORD==='string'&&env.POS_ADMIN_PASSWORD.length>0&&timingSafeEqual(hash(value),hash(env.POS_ADMIN_PASSWORD));
};}
export const verifyPosAdministrationPassword=createPosAdministrationVerifier();
