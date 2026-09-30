import axios from 'axios';

export default defineNuxtPlugin(() => {
  const client = axios.create({ baseURL: '/api', timeout: 8000, headers: { 'X-Trial-Client': 'web' } });
  return { provide: { api: client } };
});
