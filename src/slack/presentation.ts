interface SlackPresentationBase {
  readonly username?: string;
}

export type SlackMessagePresentation =
  | (SlackPresentationBase & {
      readonly icon_url?: string;
      readonly icon_emoji?: never;
    })
  | (SlackPresentationBase & {
      readonly icon_emoji?: string;
      readonly icon_url?: never;
    });

export type SlackPresentationsByChannel = Readonly<
  Record<string, SlackMessagePresentation>
>;

const DEFAULT_PRESENTATION = Object.freeze({});

export function createSlackMessagePresentation(input: {
  readonly display_name?: string | undefined;
  readonly icon_url?: string | undefined;
  readonly icon_emoji?: string | undefined;
}): SlackMessagePresentation {
  const username = input.display_name;
  if (input.icon_url !== undefined) {
    return {
      ...(username === undefined ? {} : { username }),
      icon_url: input.icon_url,
    };
  }
  if (input.icon_emoji !== undefined) {
    return {
      ...(username === undefined ? {} : { username }),
      icon_emoji: input.icon_emoji,
    };
  }
  return username === undefined ? DEFAULT_PRESENTATION : { username };
}

export function presentationForChannel(
  presentations: SlackPresentationsByChannel,
  channelId: string,
): SlackMessagePresentation {
  return presentations[channelId] ?? DEFAULT_PRESENTATION;
}
