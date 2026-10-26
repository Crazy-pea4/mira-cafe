import { appPath } from './core/app-path';
import type { StageLocation } from '../shared/stage';
export const SCENE_ARTWORK = {
  cafe: {
    src: appPath('/backgrounds/mira-cafe-galgame-background.png'),
    description: '雨夜里的咖啡馆，暖灯映着木质吧台与窗边座位',
    width: 1672,
    height: 941,
    chapter: 'CHAPTER 01 · 雨夜来客',
    title: '雨停之前',
    place: '23:47 · 城市一隅',
  },
  lodge: {
    src: appPath('/backgrounds/mira-mountain-lodge-v1.png'),
    description: '照片里的山间旅馆，雨后石阶通向亮着暖灯的门廊，远山浮在薄雾里',
    width: 1672,
    height: 941,
    chapter: 'INTERLUDE · 山间旅馆',
    title: '照片里的远方',
    place: '雨后山间 · 照片中的风景',
  },
} satisfies Record<StageLocation, {
  src: string;
  description: string;
  width: number;
  height: number;
  chapter: string;
  title: string;
  place: string;
}>;
