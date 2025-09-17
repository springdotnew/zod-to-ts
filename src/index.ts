import ts from 'typescript'
import { ZodTypeAny } from 'zod'
import {
	GetType,
	GetTypeFunction,
	LiteralType,
	ResolvedZodToTsOptions,
	resolveOptions,
	ZodToTsOptions,
	ZodToTsReturn,
	ZodToTsStore,
} from './types'
import {
	addJsDocComment,
	createTypeReferenceFromString,
	createUnknownKeywordNode,
	getIdentifierOrStringLiteral,
	maybeIdentifierToTypeReference,
} from './utils'

const { factory: f, SyntaxKind } = ts

const callGetType = (
	zod: ZodTypeAny,
	identifier: string,
	options: ResolvedZodToTsOptions,
) => {
	let type: ReturnType<GetTypeFunction> | undefined

	const getTypeSchema = zod as GetType
	// this must be called before accessing 'type'
	if (getTypeSchema._def?.getType) type = getTypeSchema._def.getType(ts, identifier, options)
	else if ((getTypeSchema as any).def?.getType) type = (getTypeSchema as any).def.getType(ts, identifier, options)
	return type
}

export const zodToTs = (
	zod: ZodTypeAny,
	identifier?: string,
	options?: ZodToTsOptions,
): ZodToTsReturn => {
	const resolvedIdentifier = identifier ?? 'Identifier'

	const resolvedOptions = resolveOptions(options)

	const store: ZodToTsStore = { nativeEnums: [] }

	const node = zodToTsNode(zod, resolvedIdentifier, store, resolvedOptions)

	return { node, store }
}

const zodToTsNode = (
	zod: ZodTypeAny,
	identifier: string,
	store: ZodToTsStore,
	options: ResolvedZodToTsOptions,
) => {
	// In Zod v4, the type is stored in def.type instead of _def.typeName
	const def = zod.def || zod._def
	if (!def) return f.createKeywordTypeNode(SyntaxKind.AnyKeyword)

	// Map Zod v4 type names to v3 format
	const typeMapping: Record<string, string> = {
		'string': 'ZodString',
		'number': 'ZodNumber',
		'bigint': 'ZodBigInt',
		'boolean': 'ZodBoolean',
		'date': 'ZodDate',
		'undefined': 'ZodUndefined',
		'null': 'ZodNull',
		'void': 'ZodVoid',
		'any': 'ZodAny',
		'unknown': 'ZodUnknown',
		'never': 'ZodNever',
		'lazy': 'ZodLazy',
		'literal': 'ZodLiteral',
		'object': 'ZodObject',
		'array': 'ZodArray',
		'enum': 'ZodEnum',
		'union': 'ZodUnion',
		'discriminated_union': 'ZodDiscriminatedUnion',
		'transform': 'ZodEffects',
		'optional': 'ZodOptional',
		'nullable': 'ZodNullable',
		'tuple': 'ZodTuple',
		'record': 'ZodRecord',
		'map': 'ZodMap',
		'set': 'ZodSet',
		'intersection': 'ZodIntersection',
		'promise': 'ZodPromise',
		'function': 'ZodFunction',
		'default': 'ZodDefault',
		'catch': 'ZodCatch',
		'nan': 'ZodNaN',
		'pipe': 'ZodPipe',
		'readonly': 'ZodReadonly',
		'template_literal': 'ZodTemplateLiteral',
		'custom': 'ZodCustom',
		'prefault': 'ZodPrefault',
		'nonoptional': 'ZodNonOptional',
		'success': 'ZodSuccess',
	}

	// Use the type property directly from Zod v4
	const zodType = (zod as any).type || (def as any).type || (def as any).typeName
	const typeName = typeMapping[zodType] || zodType || 'ZodAny'


	const getTypeType = callGetType(zod, identifier, options)
	// special case native enum and lazy, which need special handling
	if (getTypeType && typeName !== 'ZodNativeEnum' && typeName !== 'ZodEnum' && typeName !== 'ZodLazy') {
		return maybeIdentifierToTypeReference(getTypeType)
	}

	const otherArguments = [identifier, store, options] as const

	switch (typeName) {
		case 'ZodString': {
			return f.createKeywordTypeNode(SyntaxKind.StringKeyword)
		}
		case 'ZodNumber': {
			return f.createKeywordTypeNode(SyntaxKind.NumberKeyword)
		}
		case 'ZodBigInt': {
			return f.createKeywordTypeNode(SyntaxKind.BigIntKeyword)
		}
		case 'ZodBoolean': {
			return f.createKeywordTypeNode(SyntaxKind.BooleanKeyword)
		}
		case 'ZodDate': {
			return f.createTypeReferenceNode(f.createIdentifier('Date'))
		}
		case 'ZodUndefined': {
			return f.createKeywordTypeNode(SyntaxKind.UndefinedKeyword)
		}
		case 'ZodNull': {
			return f.createLiteralTypeNode(f.createNull())
		}
		case 'ZodVoid': {
			return f.createUnionTypeNode([
				f.createKeywordTypeNode(SyntaxKind.VoidKeyword),
				f.createKeywordTypeNode(SyntaxKind.UndefinedKeyword),
			])
		}
		case 'ZodAny': {
			return f.createKeywordTypeNode(SyntaxKind.AnyKeyword)
		}
		case 'ZodUnknown': {
			return createUnknownKeywordNode()
		}
		case 'ZodNever': {
			return f.createKeywordTypeNode(SyntaxKind.NeverKeyword)
		}
		case 'ZodLazy': {
			// it is impossible to determine what the lazy value is referring to
			// so we force the user to declare it
			if (getTypeType) return maybeIdentifierToTypeReference(getTypeType)
			return createTypeReferenceFromString(identifier)
		}
		case 'ZodLiteral': {
			// z.literal('hi') -> 'hi'
			let literal: ts.LiteralExpression | ts.BooleanLiteral

			// In Zod v4, literals have values as an array, not a single value
			const literalValue = ((def as any).values?.[0] ?? (def as any).value) as LiteralType
			switch (typeof literalValue) {
				case 'number': {
					literal = f.createNumericLiteral(literalValue)
					break
				}
				case 'boolean': {
					literal = literalValue === true ? f.createTrue() : f.createFalse()
					break
				}
				default: {
					literal = f.createStringLiteral(literalValue)
					break
				}
			}

			return f.createLiteralTypeNode(literal)
		}
		case 'ZodObject': {
			const shape = (def as any).shape || {}
			const properties = Object.entries(shape)

			const members: ts.TypeElement[] = properties.map(([key, value]) => {
				const nextZodNode = value as ZodTypeAny
				const type = zodToTsNode(nextZodNode, ...otherArguments)

				const nextZodType = (nextZodNode as any).type || (nextZodNode as any)._def?.typeName
				const isOptional = nextZodType === 'optional' || nextZodType === 'ZodOptional' || (nextZodNode as any).isOptional?.()

				const propertySignature = f.createPropertySignature(
					undefined,
					getIdentifierOrStringLiteral(key),
					isOptional ? f.createToken(SyntaxKind.QuestionToken) : undefined,
					type,
				)

				if (nextZodNode.description) {
					addJsDocComment(propertySignature, nextZodNode.description)
				}

				return propertySignature
			})
			return f.createTypeLiteralNode(members)
		}

		case 'ZodArray': {
			// In Zod v4, arrays have an 'element' property that contains the element schema
			const elementType = (def as any).element || (zod as any).element
			if (!elementType) return f.createArrayTypeNode(f.createKeywordTypeNode(SyntaxKind.AnyKeyword))
			const type = zodToTsNode(elementType, ...otherArguments)
			const node = f.createArrayTypeNode(type)
			return node
		}

		case 'ZodEnum': {
			// z.enum['a', 'b', 'c'] -> 'a' | 'b' | 'c
			// Also handles z.nativeEnum in Zod v4
			const entries = (def as any).entries || {}
			const values = (def as any).values || (zod as any).options || Object.values(entries)
			if (!values || values.length === 0) {
				return f.createKeywordTypeNode(SyntaxKind.NeverKeyword)
			}

			// Check if this is a native enum vs regular enum
			// Native enums have getType defined or have number values
			const hasNumberValues = Object.values(entries).some(v => typeof v === 'number')
			const hasGetType = getTypeType !== undefined

			if (hasNumberValues || hasGetType) {
				// This is a native enum, handle it like ZodNativeEnum
				const type = getTypeType

				if (options.nativeEnums === 'union') {
					// allow overriding with this option
					if (type) return maybeIdentifierToTypeReference(type)

					const types = Object.values(entries).map((value) => {
						if (typeof value === 'number') {
							return f.createLiteralTypeNode(f.createNumericLiteral(value))
						}
						return f.createLiteralTypeNode(f.createStringLiteral(value as string))
					})
					return f.createUnionTypeNode(types)
				}

				// z.nativeEnum(Fruits) -> Fruits
				// can resolve Fruits into store and user can handle enums
				if (!type) return createUnknownKeywordNode()

				if (options.nativeEnums === 'resolve') {
					const enumMembers = Object.entries(entries as Record<string, string | number>).map(([key, value]) => {
						const literal = typeof value === 'number'
							? f.createNumericLiteral(value)
							: f.createStringLiteral(value)

						return f.createEnumMember(
							getIdentifierOrStringLiteral(key),
							literal,
						)
					})

					if (ts.isIdentifier(type)) {
						store.nativeEnums.push(
							f.createEnumDeclaration(
								undefined,
								type,
								enumMembers,
							),
						)
					} else {
						throw new Error('getType on nativeEnum must return an identifier when nativeEnums is "resolve"')
					}
				}

				return maybeIdentifierToTypeReference(type)
			} else {
				// Regular enum with string values
				const types = values.map((value: string) => f.createLiteralTypeNode(f.createStringLiteral(value)))
				return f.createUnionTypeNode(types)
			}
		}

		case 'ZodUnion': {
			// z.union([z.string(), z.number()]) -> string | number
			const options: ZodTypeAny[] = (def as any).options || []
			const types: ts.TypeNode[] = options.map((option) => zodToTsNode(option, ...otherArguments))
			return f.createUnionTypeNode(types)
		}

		case 'ZodDiscriminatedUnion': {
			// z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), a: z.string() }), z.object({ kind: z.literal('b'), b: z.number() })]) -> { kind: 'a', a: string } | { kind: 'b', b: number }
			const optionsMap = (def as any).optionsMap || (def as any).options
			const options: ZodTypeAny[] = optionsMap instanceof Map ? [...optionsMap.values()] : (Array.isArray(optionsMap) ? optionsMap : [])
			const types: ts.TypeNode[] = options.map((option) => zodToTsNode(option, ...otherArguments))
			return f.createUnionTypeNode(types)
		}

		case 'ZodEffects': {
			// ignore any effects, they won't factor into the types
			const inner = (def as any).schema || (def as any).innerType || (zod as any).in || (zod as any).innerType
			const node = zodToTsNode(inner, ...otherArguments) as ts.TypeNode
			return node
		}

		case 'ZodNativeEnum': {
			const type = getTypeType

			if (options.nativeEnums === 'union') {
				// allow overriding with this option
				if (type) return maybeIdentifierToTypeReference(type)

				const values = (def as any).values || {}
				const types = Object.values(values).map((value) => {
					if (typeof value === 'number') {
						return f.createLiteralTypeNode(f.createNumericLiteral(value))
					}
					return f.createLiteralTypeNode(f.createStringLiteral(value as string))
				})
				return f.createUnionTypeNode(types)
			}

			// z.nativeEnum(Fruits) -> Fruits
			// can resolve Fruits into store and user can handle enums
			if (!type) return createUnknownKeywordNode()

			if (options.nativeEnums === 'resolve') {
				const values = (def as any).values || {}
				const enumMembers = Object.entries(values as Record<string, string | number>).map(([key, value]) => {
					const literal = typeof value === 'number'
						? f.createNumericLiteral(value)
						: f.createStringLiteral(value)

					return f.createEnumMember(
						getIdentifierOrStringLiteral(key),
						literal,
					)
				})

				if (ts.isIdentifier(type)) {
					store.nativeEnums.push(
						f.createEnumDeclaration(
							undefined,
							type,
							enumMembers,
						),
					)
				} else {
					throw new Error('getType on nativeEnum must return an identifier when nativeEnums is "resolve"')
				}
			}

			return maybeIdentifierToTypeReference(type)
		}

		case 'ZodOptional': {
			const inner = (def as any).innerType || (zod as any).unwrap()
			const innerType = zodToTsNode(inner, ...otherArguments) as ts.TypeNode
			return f.createUnionTypeNode([
				innerType,
				f.createKeywordTypeNode(SyntaxKind.UndefinedKeyword),
			])
		}

		case 'ZodNullable': {
			const inner = (def as any).innerType || (zod as any).unwrap()
			const innerType = zodToTsNode(inner, ...otherArguments) as ts.TypeNode
			return f.createUnionTypeNode([
				innerType,
				f.createLiteralTypeNode(f.createNull()),
			])
		}

		case 'ZodTuple': {
			// z.tuple([z.string(), z.number()]) -> [string, number]
			const items = (def as any).items || []
			const types = items.map((option: ZodTypeAny) => zodToTsNode(option, ...otherArguments))
			return f.createTupleTypeNode(types)
		}

		case 'ZodRecord': {
			// z.record(z.number()) -> { [x: string]: number }
			const valueType = zodToTsNode((def as any).valueType, ...otherArguments)

			const node = f.createTypeLiteralNode([f.createIndexSignature(
				undefined,
				[f.createParameterDeclaration(
					undefined,
					undefined,
					f.createIdentifier('x'),
					undefined,
					f.createKeywordTypeNode(SyntaxKind.StringKeyword),
				)],
				valueType,
			)])

			return node
		}

		case 'ZodMap': {
			// z.map(z.string()) -> Map<string>
			const valueType = zodToTsNode((def as any).valueType, ...otherArguments)
			const keyType = zodToTsNode((def as any).keyType, ...otherArguments)

			const node = f.createTypeReferenceNode(
				f.createIdentifier('Map'),
				[
					keyType,
					valueType,
				],
			)

			return node
		}

		case 'ZodSet': {
			// z.set(z.string()) -> Set<string>
			const type = zodToTsNode((def as any).valueType, ...otherArguments)

			const node = f.createTypeReferenceNode(
				f.createIdentifier('Set'),
				[type],
			)
			return node
		}

		case 'ZodIntersection': {
			// z.number().and(z.string()) -> number & string
			const left = zodToTsNode((def as any).left, ...otherArguments)
			const right = zodToTsNode((def as any).right, ...otherArguments)
			const node = f.createIntersectionTypeNode([left, right])
			return node
		}

		case 'ZodPromise': {
			// z.promise(z.string()) -> Promise<string>
			const innerType = (def as any).type || (def as any).innerType || (zod as any).unwrap()
			const type = zodToTsNode(innerType, ...otherArguments)

			const node = f.createTypeReferenceNode(
				f.createIdentifier('Promise'),
				[type],
			)

			return node
		}

		case 'ZodFunction': {
			// z.function().args(z.string()).returns(z.number()) -> (args_0: string) => number
			const input = (def as any).input
			const items = (input && input.def && input.def.items) || []
			const argumentTypes = items.map((argument: ZodTypeAny, index: number) => {
				const argumentType = zodToTsNode(argument, ...otherArguments)

				return f.createParameterDeclaration(
					undefined,
					undefined,
					f.createIdentifier(`args_${index}`),
					undefined,
					argumentType,
				)
			}) as ts.ParameterDeclaration[]

			argumentTypes.push(
				f.createParameterDeclaration(
					undefined,
					f.createToken(SyntaxKind.DotDotDotToken),
					f.createIdentifier(`args_${argumentTypes.length}`),
					undefined,
					f.createArrayTypeNode(createUnknownKeywordNode()),
				),
			)

			const output = (def as any).output
			const returnType = output ? zodToTsNode(output, ...otherArguments) : f.createKeywordTypeNode(SyntaxKind.UnknownKeyword)

			const node = f.createFunctionTypeNode(
				undefined,
				argumentTypes,
				returnType,
			)

			return node
		}

		case 'ZodDefault': {
			// z.string().optional().default('hi') -> string
			const inner = (def as any).innerType || (zod as any).unwrap()
			const type = zodToTsNode(inner, ...otherArguments) as ts.TypeNode

			const filteredNodes: ts.Node[] = []

			type.forEachChild((node) => {
				if (!([SyntaxKind.UndefinedKeyword].includes(node.kind))) {
					filteredNodes.push(node)
				}
			})

			// @ts-expect-error needed to set children
			type.types = filteredNodes

			return type
		}
	}

	// Fallback to 'any' type if no case matched
	return f.createKeywordTypeNode(SyntaxKind.AnyKeyword)
}

export { createTypeAlias, printNode, withGetType } from './utils'

export { type GetType, type ZodToTsOptions } from './types'
