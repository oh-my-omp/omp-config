import type { Api, Model as HostModel } from "@oh-my-pi/pi-ai";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";

export type Model = HostModel<Api>;
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
