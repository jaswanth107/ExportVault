import { apiRequest } from './client';
import type { User } from '../types';

export function register(input: { name: string; email: string; password: string }) {
  return apiRequest<{ success: true; user: User }>('/api/auth/register', {
    method: 'POST',
    body: input,
    auth: false,
  });
}

export function login(input: { email: string; password: string }) {
  return apiRequest<{ success: true; token: string; user: User }>('/api/auth/login', {
    method: 'POST',
    body: input,
    auth: false,
  });
}

export function fetchMe() {
  return apiRequest<{ success: true; user: User }>('/api/auth/me');
}
