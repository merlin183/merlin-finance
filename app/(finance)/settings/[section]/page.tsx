import {notFound} from 'next/navigation';
import {settingsSections} from '../../routes';

export default async function Page({params}:{params:Promise<{section:string}>}){
 const {section}=await params;
 if(!settingsSections.some(allowed=>allowed===section))notFound();
 return null;
}
