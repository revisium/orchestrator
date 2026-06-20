export function GraphqlParamTypes(...types: unknown[]): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata('design:paramtypes', types, target, propertyKey);
  };
}
