import {descriptionIdentity} from './classification-review';
import type {MerchantNote,Transaction} from './types';
export function noteSubject(t:Transaction){const identity=descriptionIdentity(t.description);return {account_id:t.account_id,direction:t.direction,subject_key:identity.ambiguous?'transaction:'+t.id:identity.key,label:identity.label};}
export function noteKey(note:Pick<MerchantNote,'account_id'|'direction'|'subject_key'>){return JSON.stringify([note.account_id,note.direction,note.subject_key]);}
