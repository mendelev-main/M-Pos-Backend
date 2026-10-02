(function(root){
  const VERSION=1;
  const PREFIX='project_guest_menu_cache_v1:';
  const MAX_AGE_MS=24*60*60*1000;

  function validMenu(value){
    return Boolean(value&&Array.isArray(value.categories)&&Array.isArray(value.products));
  }

  function storage(){
    try{return root.localStorage||null}catch(_error){return null}
  }

  function read(surface,freshForMs,maxAgeMs=MAX_AGE_MS){
    try{
      const raw=storage()?.getItem(PREFIX+surface);
      if(!raw)return null;
      const entry=JSON.parse(raw),ageMs=Math.max(0,Date.now()-Number(entry?.savedAt||0));
      if(entry?.version!==VERSION||!validMenu(entry.menu)||!Number.isFinite(ageMs)||ageMs>maxAgeMs){storage()?.removeItem(PREFIX+surface);return null}
      return {menu:entry.menu,ageMs,fresh:ageMs<=freshForMs};
    }catch(_error){return null}
  }

  function write(surface,menu){
    if(!validMenu(menu))return false;
    try{storage()?.setItem(PREFIX+surface,JSON.stringify({version:VERSION,savedAt:Date.now(),menu}));return true}catch(_error){return false}
  }

  root.GuestMenuCache={read,write,version:VERSION};
})(typeof window!=='undefined'?window:globalThis);
