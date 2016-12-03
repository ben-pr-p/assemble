import { Component, h } from 'preact'
import IconCore from './icon-core'

export default class EditIcon extends Component {
  render (props, state) {
    return (
      <IconCore {...props} >
        <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/>
        <path d="M0 0h24v24H0z" fill="none"/>
      </IconCore>
    )
  }
}
