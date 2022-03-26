/* eslint-disable @typescript-eslint/no-explicit-any */
import { assertNotBrowser } from '../assertNotBrowser';
import { ProcedureType } from '../router';
import { TRPCError } from '../TRPCError';
import { getErrorFromUnknown } from './errors';
import { MiddlewareFunction, middlewareMarker } from './middlewares';
import { wrapCallSafe } from './wrapCallSafe';
assertNotBrowser();

export type ProcedureParserZodEsque<T> = {
  parse: (input: unknown) => T;
};

export type ProcedureParserSuperstructEsque<T> = {
  create: (input: unknown) => T;
};

export type ProcedureParserCustomValidatorEsque<T> = (
  input: unknown,
) => T | Promise<T>;

export type ProcedureParserYupEsque<T> = {
  validateSync: (input: unknown) => T;
};

export type ProcedureParser<T> =
  | ProcedureParserYupEsque<T>
  | ProcedureParserSuperstructEsque<T>
  | ProcedureParserCustomValidatorEsque<T>
  | ProcedureParserZodEsque<T>;

export type ProcedureParserZodTransformEsque<T, TParsed> = {
  _input: T;
  _output: TParsed;
};

export type ProcedureResolver<TContext, TParsedInput, TOutput> = (opts: {
  ctx: TContext;
  input: TParsedInput;
  type: ProcedureType;
}) => Promise<TOutput> | TOutput;

interface ProcedureOptions<TContext, TParsedInput, TOutput> {
  middlewares: Array<MiddlewareFunction<any, any>>;
  resolver: ProcedureResolver<TContext, TParsedInput, TOutput>;
  inputParser: ProcedureParser<TParsedInput>;
  outputParser: ProcedureParser<TOutput> | undefined;
}

/**
 * @internal
 */
export interface ProcedureCallOptions<TContext> {
  ctx: TContext;
  rawInput: unknown;
  path: string;
  type: ProcedureType;
}

type ParseFn<T> = (value: unknown) => T | Promise<T>;

function getParseFn<T>(_parser: ProcedureParser<T>): ParseFn<T> {
  const parser = _parser as any;

  if (typeof parser === 'function') {
    // ProcedureParserCustomValidatorEsque
    return parser;
  }

  if (typeof parser.parseAsync === 'function') {
    // ProcedureParserZodEsque
    return parser.parseAsync.bind(parser);
  }

  if (typeof parser.parse === 'function') {
    // ProcedureParserZodEsque
    return parser.parse.bind(parser);
  }

  if (typeof parser.validateSync === 'function') {
    // ProcedureParserYupEsque
    return parser.validateSync.bind(parser);
  }

  if (typeof parser.create === 'function') {
    // ProcedureParserSuperstructEsque
    return parser.create.bind(parser);
  }

  throw new Error('Could not find a validator fn');
}

/**
 * @internal
 */
export class Procedure<TInputContext, TContext, TInput, TParsedInput, TOutput> {
  private middlewares: Readonly<Array<MiddlewareFunction<any, any>>>;
  private resolver: ProcedureResolver<TContext, TParsedInput, TOutput>;
  public readonly inputParser: ProcedureParser<TParsedInput>;
  private parseInputFn: ParseFn<TParsedInput>;
  public readonly outputParser: ProcedureParser<TOutput> | undefined;
  private parseOutputFn: ParseFn<TOutput>;

  constructor(opts: ProcedureOptions<TContext, TParsedInput, TOutput>) {
    this.middlewares = opts.middlewares;
    this.resolver = opts.resolver;
    this.inputParser = opts.inputParser;
    this.parseInputFn = getParseFn(this.inputParser);
    this.outputParser = opts.outputParser;
    this.parseOutputFn =
      this.outputParser && process.env.TRPC_SKIP_OUTPUT_VALIDATION !== 'true'
        ? getParseFn(this.outputParser)
        : (output: unknown) => output as TOutput;
  }

  private async parseInput(rawInput: unknown): Promise<TParsedInput> {
    try {
      return await this.parseInputFn(rawInput);
    } catch (cause) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        cause,
        message: 'Input validation failed',
      });
    }
  }

  private async parseOutput(rawOutput: unknown): Promise<TOutput> {
    try {
      return await this.parseOutputFn(rawOutput);
    } catch (cause) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        cause,
        message: 'Output validation failed',
      });
    }
  }

  /**
   * Trigger middlewares in order, parse raw input, call resolver & parse raw output
   * @internal
   */
  public async call(
    opts: ProcedureCallOptions<TInputContext>,
  ): Promise<TOutput> {
    // wrap the actual resolver and treat as the last "middleware"
    const middlewaresWithResolver = this.middlewares.concat([
      async ({ ctx }: { ctx: TContext }) => {
        const input = await this.parseInput(opts.rawInput);
        const rawOutput = await this.resolver({ ...opts, ctx, input });
        const data = await this.parseOutput(rawOutput);
        return {
          marker: middlewareMarker,
          ok: true,
          data,
          ctx,
        } as const;
      },
    ]);

    // create `next()` calls in resolvers
    const nextFns = middlewaresWithResolver.map((fn, index) => {
      return async (nextOpts?: { ctx: TContext }) => {
        const res = await wrapCallSafe(() =>
          fn({
            ctx: nextOpts ? nextOpts.ctx : opts.ctx,
            type: opts.type,
            path: opts.path,
            rawInput: opts.rawInput,
            next: nextFns[index + 1],
          }),
        );
        if (res.ok) {
          return res.data;
        }
        return {
          ok: false as const,
          error: getErrorFromUnknown(res.error),
        };
      };
    });

    // there's always at least one "next" since we wrap this.resolver in a middleware
    const result = await nextFns[0]();
    if (!result) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'No result from middlewares - did you forget to `return next()`?',
      });
    }
    if (!result.ok) {
      // re-throw original error
      throw result.error;
    }

    return result.data as TOutput;
  }

  /**
   * Create new procedure with passed middlewares
   * @param middlewares
   */
  public inheritMiddlewares(
    middlewares: MiddlewareFunction<TInputContext, TContext>[],
  ): this {
    const Constructor: {
      new (opts: ProcedureOptions<TContext, TParsedInput, TOutput>): Procedure<
        TInputContext,
        TContext,
        TInput,
        TParsedInput,
        TOutput
      >;
    } = (this as any).constructor;

    const instance = new Constructor({
      middlewares: [...middlewares, ...this.middlewares],
      resolver: this.resolver,
      inputParser: this.inputParser,
      outputParser: this.outputParser,
    });

    return instance as any;
  }
}

export type CreateProcedureWithInput<TContext, TInput, TParsedInput, TOutput> =
  {
    input: ProcedureParser<TInput>;
    output?: ProcedureParser<TOutput>;
    resolve: ProcedureResolver<TContext, TParsedInput, TOutput>;
  };

export type CreateProcedureWithTransformInput<
  TContext,
  TInput,
  TParsedInput,
  TOutput,
> = {
  input: ProcedureParserZodTransformEsque<TInput, TParsedInput>;
  output?: ProcedureParser<TOutput>;
  resolve: ProcedureResolver<TContext, TParsedInput, TOutput>;
};

export type CreateProcedureWithoutInput<TContext, TOutput> = {
  output?: ProcedureParser<TOutput>;
  resolve: ProcedureResolver<TContext, undefined, TOutput>;
};

export type CreateProcedureOptions<
  TContext,
  TInput = undefined,
  TParsedInput = undefined,
  TOutput = undefined,
> =
  | CreateProcedureWithInput<TContext, TInput, TParsedInput, TOutput>
  | CreateProcedureWithTransformInput<TContext, TInput, TParsedInput, TOutput>
  | CreateProcedureWithoutInput<TContext, TOutput>;

export function createProcedure<TContext, TInput, TParsedInput, TOutput>(
  opts: CreateProcedureOptions<TContext, TInput, TParsedInput, TOutput>,
): Procedure<unknown, TContext, TInput, TParsedInput, TOutput> {
  const inputParser =
    'input' in opts && opts.input
      ? opts.input
      : (input: unknown) => {
          if (input != null) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'No input expected',
            });
          }
          return undefined;
        };

  return new Procedure({
    inputParser: inputParser as any,
    resolver: opts.resolve as any,
    middlewares: [],
    outputParser: opts.output as any,
  });
}

export type inferProcedureFromOptions<
  TInputContext,
  TOptions extends CreateProcedureOptions<any, any, any, any>,
> = TOptions extends CreateProcedureOptions<
  infer TContext,
  infer TInput,
  infer TParsedInput,
  infer TOutput
>
  ? Procedure<
      TInputContext,
      TContext,
      unknown extends TInput ? undefined : TInput,
      unknown extends TParsedInput ? undefined : TParsedInput,
      TOutput
    >
  : never;
