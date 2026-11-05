import {ClobeImportError} from './import-security';
import type {ClobeSyncSkip} from './import-types';

/** These fields are safe account/month diagnostics, never provider payloads. */
export class ClobeSyncSourceError extends ClobeImportError{
 constructor(readonly skipped:ClobeSyncSkip[],readonly configured_account_count:number){
  super('incomplete','이 월에 검증을 마친 통장이 없어 거래를 저장하지 않았습니다. 통장별 은행 수집 상태를 확인해주세요.');
 }
}
