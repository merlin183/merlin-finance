import {FinanceRoot} from '@/components/finance/root';

export const dynamic='force-dynamic';

export default function FinanceLayout({children}:{children:React.ReactNode}){
 return <FinanceRoot>{children}</FinanceRoot>;
}
