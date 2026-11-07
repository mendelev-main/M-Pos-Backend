const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
test('versioned Android credential validates only new digest; old clients retain configured server authorization',async()=>{
 const {createPosAdministrationVerifier}=await import('../pos-administration-auth.js');
 const verify=createPosAdministrationVerifier(createHash('sha256').update('fixture-new-password').digest('hex'));
 assert.equal(verify('fixture-new-password','android-admin-2026-11',{POS_ADMIN_PASSWORD:'fixture-old'}),true);
 assert.equal(verify('fixture-old','android-admin-2026-11',{POS_ADMIN_PASSWORD:'fixture-old'}),false);
 assert.equal(verify('fixture-old',undefined,{POS_ADMIN_PASSWORD:'fixture-old'}),true);
 assert.equal(verify('fixture-new-password',undefined,{POS_ADMIN_PASSWORD:'fixture-old'}),false);
 assert.equal(verify('fixture-new-password','unknown-version',{POS_ADMIN_PASSWORD:'fixture-new-password'}),false);
 assert.equal(verify('',undefined,{}),false);assert.equal(verify(null,'android-admin-2026-11'),false);
});
