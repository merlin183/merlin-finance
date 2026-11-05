'use client';
import {createBrowserClient} from '@supabase/ssr';
export function browserClient(url:string,key:string){return createBrowserClient(url,key)}
