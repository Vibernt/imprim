import type { TweaksPatch } from 'fire-design';

export const languages = [['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt-BR', 'Português (Brasil)']] as const;
export const assets = ['logo_light', 'logo_dark', 'mark'] as const;
export type Asset = typeof assets[number];
export type Look = Omit<TweaksPatch, 'brand'>;
export interface Branding {
  name?: string;
  legal_name?: string;
  support_email?: string;
  support_url?: string;
  privacy_url?: string;
  terms_url?: string;
  locale?: string;
  locales?: string[];
  copy?: Record<string, string>;
  locale_copy?: Record<string, Record<string, string>>;
  look?: Look;
  logo_light?: string;
  logo_dark?: string;
  mark?: string;
}
export interface BrandResponse { branding: Branding; version: number }
