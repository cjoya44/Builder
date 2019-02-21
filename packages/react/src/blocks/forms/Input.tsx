import React from 'react'
import { BuilderBlock } from '../../decorators/builder-block.decorator'

// TODO: how do onchange...
// TODO: actions all custom events and custom js gets
// passed an element reference and listens for events....
// Needs to unsubscribe, so must manage
export interface FormInputProps {
  type?: string
  attributes?: any
  name?: string
  value?: string
  placeholder?: string
}

@BuilderBlock({
  name: 'Form:Input',
  image:
    'https://cdn.builder.codes/api/v1/image/assets%2FIsxPKMo2gPRRKeakUztj1D6uqed2%2Fad6f37889d9e40bbbbc72cdb5875d6ca',
  inputs: [
    {
      name: 'type',
      type: 'text',
      enum: [
        'text',
        'number',
        'email',
        'url',
        'checkbox',
        'radio',
        'range',
        'date',
        'datetime-local',
        'search',
        'tel',
        'time',
        'month',
        'week',
        'color'
      ],
      defaultValue: 'text'
    },
    {
      name: 'value',
      type: 'string'
    },
    {
      name: 'placeholder',
      type: 'string'
    },
    {
      name: 'name',
      type: 'string'
    }
  ],
  noWrap: true
})
export class FormInput extends React.Component<FormInputProps> {
  render() {
    return (
      <input
        placeholder={this.props.placeholder}
        type={this.props.type}
        name={this.props.name}
        value={this.props.value}
        {...this.props.attributes}
      />
    )
  }
}
