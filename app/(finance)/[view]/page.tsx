import {notFound} from 'next/navigation';
import {financeViews} from '../routes';

export default async function Page({params}:{params:Promise<{view:string}>}){
 const {view}=await params;
 if(!financeViews.some(allowed=>allowed===view))notFound();
 return null;
}
