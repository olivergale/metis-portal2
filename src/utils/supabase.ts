import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://phfblljwuvzqzlbzkzpr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoZmJsbGp3dXZ6cXpsYnprenByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjAzODgsImV4cCI6MjA4NTA5NjM4OH0.mWIj2vtQb1F2Pk540f_S9WwsZFwZK0n6oeqUmZgDZlA';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
