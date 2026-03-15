/**
 * WebSocket URL construction utility.
 * Centralizes WebSocket URL generation to avoid hardcoded hosts/ports across client components.
 */
import { getBasePath } from './basePath';

/** Build a client-side WebSocket URL using the current page's host */
export const buildWsUrl = (path: string, params?: Record<string, string>): string => {
  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof window !== 'undefined'
    ? window.location.host
    : 'localhost:8888';
  const basePath = getBasePath();
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return `${protocol}//${host}${basePath}${path}${qs}`;
};

/** Build a server-side WebSocket URL from an incoming request's Host header */
export const buildWsUrlFromHost = (host: string, path: string, params?: Record<string, string>): string => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return `ws://${host}${path}${qs}`;
};
