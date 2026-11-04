export type QuestionKind = 'single' | 'multiple' | 'blank' | 'subjective';
export interface Lesson { id: string; classroomId: string; name: string }
export interface Identity { id: string; name: string }
export interface QuestionContext {
  accountId: string; lessonId: string; questionId: string; presentationId: string;
  kind: QuestionKind; platformType: number; stem: string;
  options: { key: string; text: string }[]; blankCount: number;
  imageUrls: string[]; images: string[]; coverUrl?: string; captureSource?: 'original' | 'screenshot';
  revision: string; deadline: number | null; open: boolean; answered: boolean;
}
export interface AnswerProposal { kind: QuestionKind; answers: string[]; explanation: string }
export interface SubmissionReceipt { status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN'; message: string }
export type TaskStatus = 'QUEUED' | 'CAPTURING' | 'SOLVING' | 'PREVIEW' | 'SUBMITTING' | 'ACCEPTED' | 'REJECTED' | 'UNKNOWN' | 'SKIPPED';
export interface TaskRecord { key: string; questionId: string; lessonId: string; kind: QuestionKind; status: TaskStatus; message: string; updatedAt: number; answers?: string[] }
export interface ModelConfig { baseUrl: string; model: string; apiKey: string }
export interface PublicModelConfig { baseUrl: string; model: string; hasKey: boolean; tested: boolean }
export interface AppState {
  identity: Identity | null; lessons: Lesson[]; selected: Lesson | null;
  mode: 'stopped' | 'preview' | 'auto' | 'paused'; connection: string;
  question: QuestionContext | null; proposal: AnswerProposal | null;
  records: TaskRecord[]; model: PublicModelConfig; notice: string;
}
export type Command =
  | { type: 'state' | 'login' | 'refresh' | 'logout' | 'pause' | 'stop' | 'hidePlatform' | 'testModel' }
  | { type: 'select'; lessonId: string }
  | { type: 'start'; mode: 'preview' | 'auto' }
  | { type: 'saveModel'; config: ModelConfig };
export interface DesktopApi { command(command: Command): Promise<AppState>; subscribe(callback: (state: AppState) => void): () => void }
