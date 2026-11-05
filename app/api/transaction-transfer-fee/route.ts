import {authenticated} from '@/lib/supabase/server';
import {transferFeeHandler} from '@/lib/finance/transfer-fee-request';

export const POST=transferFeeHandler({authenticate:authenticated});
