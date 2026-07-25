'use strict';
// Config Supabase du Workshop. anon key = PUBLIQUE (RLS protège l'accès). Aucun secret.
const SUPABASE_URL = 'https://kdrycvlxbynemxweyypg.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtkcnljdmx4YnluZW14d2V5eXBnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5OTQ3MjAsImV4cCI6MjEwMDU3MDcyMH0.asJ-cNFxX79fHz1UvbOFvsy6GZ4FQ0x-GDAO9CXiW5I';

function restUrl(path, query) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  return `${SUPABASE_URL}/rest/v1/${path}${qs}`;
}
function fnUrl(name) { return `${SUPABASE_URL}/functions/v1/${name}`; }
function authHeaders(token) {
  return { apikey: ANON_KEY, Authorization: 'Bearer ' + (token || ANON_KEY) };
}
module.exports = { SUPABASE_URL, ANON_KEY, restUrl, fnUrl, authHeaders };
