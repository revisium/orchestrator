import { InputType } from '@nestjs/graphql';
import { ConnectionInput } from '../../share/inputs/connection.input.js';

@InputType()
export class ListMethodInput extends ConnectionInput {}
