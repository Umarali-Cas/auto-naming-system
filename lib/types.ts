export type Status = 'review' | 'uncertain' | 'invalid' | 'sending' | 'sent' | 'rejected';

export interface Item {
  raw: string;
  status: Status;
  stress: number | null; // индекс ударной буквы в raw
  conf: number; // 0..1
  reason?: string;
}
export interface Person extends Item {
  id: number;
  out?: string; // итоговая строка, ушедшая на сервер
  http?: number;
  fixed?: boolean; // имя исправлено вручную во вкладке «Ошибки»
}
