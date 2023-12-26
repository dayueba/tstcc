export interface TccComponent {
    id: string;

    try(): Promise<void>

    confirm(): Promise<void>;

    cancel(): Promise<void>;
}
