(function(root){
  'use strict';
  function normalizePhone(value){
    const raw=String(value||'').trim();
    if(!/^\+375[\d\s()-]+$/.test(raw))return '';
    const phone=raw.replace(/[\s()-]/g,'');
    return /^\+375\d{9}$/.test(phone)?phone:'';
  }
  function hasProfanity(value){
    const words=String(value||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[\u200b-\u200d\ufeff]/g,'').match(/[а-яa-z]+/g)||[];
    const slur=/^(?:п[ие]д(?:ор|ар)[а-я]*|п[ие]дик(?:а|у|ом|е|и|ов|ам|ами|ах)?|п[ие]дераст[а-я]*|суч(?:к|ар|он)[а-я]*|гей|геи|гея|гею|геем|геев|геям|геями|геях|гейчик[а-я]*|ге[ию]ш[а-я]*|долбо[её]б[а-я]*|[её]блан[а-я]*|идиот[а-я]*|дебил[а-я]*|кретин[а-я]*|шлюх[а-я]*|[её]бан[а-я]*|[её]буч[а-я]*|залуп[а-я]*|дроч[а-я]*|жоп[а-я]*)$/;
    return words.some(word=>slur.test(word)||/^(?:(?:на|по|ни|за)?хуй[а-я]*|ху[еяи][а-я]*|пизд[а-я]*|(?:за|вы|на|от|до|пере|по)?еб(?:а|у|и|л|н|о)[а-я]*|бля(?:д[а-я]*|ть|ха)?|сука|суки|суку|сукой|сукам|суками|суках|мудак[а-я]*|мудил[а-я]*|гандон[а-я]*|говно[а-я]*|дерьм[а-я]*|fuck[a-z]*|shit|bullshit|bitch(?:es)?|asshole[s]?|blyat|blyad|pizd[a-z]*|khuy|huy)$/.test(word));
  }
  function validateFirstName(value){
    const name=String(value||'').normalize('NFC').trim();
    if(hasProfanity(name))return 'Уберите оскорбления и нецензурные выражения из имени.';
    if(!name||name.length>50||!/^\p{L}[\p{L}\p{M}]*(?:[-'’]\p{L}[\p{L}\p{M}]*)*$/u.test(name)){
      return 'Введите только имя без фамилии: буквы, при необходимости дефис или апостроф, до 50 символов.';
    }
    return '';
  }
  function validate(data){
    if(!normalizePhone(data.phone))return 'Введите телефон: +375 и 9 цифр номера.';
    const nameError=validateFirstName(data.customerName);
    if(nameError)return nameError;
    if(hasProfanity(data.address))return 'Уберите оскорбления и нецензурные выражения из адреса доставки.';
    if(hasProfanity(data.comment)||(Array.isArray(data.items)&&data.items.some(item=>hasProfanity(item?.comment))))return 'Уберите оскорбления и нецензурные выражения из комментария.';
    return '';
  }
  root.OrderValidation=Object.freeze({normalizePhone,hasProfanity,validateFirstName,validate});

})(globalThis);
