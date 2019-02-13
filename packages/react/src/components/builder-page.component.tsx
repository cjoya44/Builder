import React from 'react'
import ReactDOM from 'react-dom'
import { BuilderContent } from './builder-content.component'
import { BuilderBlocks } from './builder-blocks.component'
import { Builder, GetContentOptions, builder, Subscription, BehaviorSubject } from '@builder.io/sdk'
import { BuilderStoreContext } from '../store/builder-store'
import produce from 'immer'
import mapValues from 'lodash-es/mapValues'
import pick from 'lodash-es/pick'
import throttle from 'lodash-es/throttle'
import { sizes } from '../constants/device-sizes.constant'
import {
  BuilderAsyncRequestsContext,
  RequestOrPromise,
  RequestInfo,
  isRequestInfo
} from '../store/builder-async-requests'
import { Url } from 'url'

// TODO: get fetch from core JS....
const fetch = Builder.isBrowser ? window.fetch : require('node-fetch')

function decorator(fn: Function) {
  return function argReceiver(...fnArgs: any[]) {
    // Check if the decorator is being called without arguments (ex `@foo methodName() {}`)
    if (fnArgs.length === 3) {
      const [target, key, descriptor] = fnArgs
      if (descriptor && (descriptor.value || descriptor.get)) {
        fnArgs = []
        return descriptorChecker(target, key, descriptor)
      }
    }

    return descriptorChecker

    // descriptorChecker determines whether a method or getter is being decorated
    // and replaces the appropriate key with the decorated function.
    function descriptorChecker(target: any, key: any, descriptor: any) {
      const descriptorKey = descriptor.value ? 'value' : 'get'
      return {
        ...descriptor,
        [descriptorKey]: fn(descriptor[descriptorKey], ...fnArgs)
      }
    }
  }
}

const Throttle = decorator(throttle)

const fetchCache: { [key: string]: any } = {}

export interface BuilderPageProps {
  modelName?: string
  name?: string
  data?: any
  entry?: string
  apiKey?: string
  options?: GetContentOptions
  contentLoaded?: (data: any) => void
  contentError?: (error: any) => void
  content?: any
  location?: Location | Url
  onStateChange?: (newData: any) => void
  noAsync?: boolean
  emailMode?: boolean
}

interface BuilderPageState {
  state: any
  update: (state: any) => any
}

const tryEval = (str?: string, data: any = {}, errors?: Error[]): any => {
  const value = str
  if (!(value && value.trim())) {
    return
  }
  const useReturn = !(value.includes(';') || value.includes(' return '))
  let fn: Function = () => {
    /* Intentionally empty */
  }
  try {
    if (Builder.isBrowser) {
      // tslint:disable-next-line:no-function-constructor-with-string-args
      // TODO: VM in node......
      fn = new Function(
        'state',
        `with (state) {
          ${useReturn ? `return (${value});` : value};
         }`
      )
    }
  } catch (error) {
    console.warn('Could not compile function', error)
  }
  try {
    if (Builder.isBrowser) {
      return fn(data || {})
    } else {
      // const { VM } = require('vm2')
      // return new VM({
      //   sandbox: {
      //     ...data,
      //     ...{ state: data }
      //   }
      //   // TODO: convert reutrn to module.exports on server
      // }).run(value)
    }
  } catch (error) {
    if (errors) {
      errors.push(error)
    }
    console.warn('Eval error', error)
  }

  return
}

function searchToObject(location: Location | Url) {
  const pairs = (location.search || '').substring(1).split('&')
  const obj: { [key: string]: string } = {}

  for (const i in pairs) {
    if (pairs[i] === '') continue
    const pair = pairs[i].split('=')
    obj[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1])
  }

  return obj
}

export class BuilderPage extends React.Component<BuilderPageProps, BuilderPageState> {
  subscriptions: Subscription = new Subscription()
  onStateChange = new BehaviorSubject<any>(null)

  get name(): string | undefined {
    return this.props.modelName || this.props.name // || this.props.model
  }

  private _asyncRequests?: RequestOrPromise[]
  private _errors?: Error[]
  private _logs?: string[]

  constructor(props: BuilderPageProps) {
    super(props)

    this.state = {
      state: {
        location: this.locationState,
        deviceSize: this.deviceSizeState,
        ...this.props.data
      },
      update: this.updateState
    }
  }

  get locationState() {
    return {
      ...pick(this.location, 'pathname', 'hostname', 'search', 'host'),
      path: this.location.pathname.split('/').slice(1),
      query: searchToObject(this.location)
    }
  }

  // TODO: trigger state change on screen size change
  get deviceSizeState() {
    // TODO: use context to pass this down on server
    return Builder.isBrowser ? sizes.getSizeForWidth(window.innerWidth) : 'large'
  }

  // TODO: different options per device size...........................

  static renderInto(elementOrSelector: string | HTMLElement, props: BuilderPageProps = {}) {
    const element =
      elementOrSelector instanceof HTMLElement
        ? elementOrSelector
        : document.querySelector(elementOrSelector)

    if (!element) {
      return
    }

    return ReactDOM.hydrate(<BuilderPage {...props} />, element)
  }

  componentWillMount() {
    const key = this.props.apiKey
    if (key && key !== builder.apiKey) {
      builder.apiKey = key
    }

    if (this.props.content) {
      // TODO: possibly observe for change or throw error if changes
      this.onContentLoaded(this.props.content.data /*, this.props.content*/)
    }
  }

  componentDidMount() {
    if (Builder.isIframe) {
      parent.postMessage({ type: 'builder.sdkInjected', data: { modelName: this.name } }, '*')
    }
  }

  updateState = (fn: (state: any) => void) => {
    const nextState = produce(this.state.state, draftState => {
      fn(draftState)
    })
    this.setState({
      update: this.updateState,
      state: nextState
    })
    if (this.props.onStateChange) {
      this.props.onStateChange(nextState)
    }
    this.onStateChange.next(nextState)
  }

  processStateFromApi(state: { [key: string]: string }) {
    return mapValues(state, value => tryEval(value, this.data, this._errors))
  }

  get location() {
    return this.props.location || (Builder.isBrowser ? location : ({} as any))
  }

  getCssFromFont(font: any) {
    const family = font.family + (font.kind && !font.kind.includes('#') ? ', ' + font.kind : '')
    const name = family.split(',')[0]
    const formatString = font.isUserFont ? ' format("woff")' : ''
    const url = font.fileUrl ? font.fileUrl : font.files && font.files.regular
    if (url && family && name) {
      return `
        @font-face {
          font-family: ${family};
          src: local("${name}"), url('${url}');
          font-display: fallback;
        }
        `
    }
    return ''
  }

  componentWillUnmount() {
    this.unsubscribe()
  }

  getFontCss(data: any) {
    // TODO: separate internal data from external
    return (
      data.customFonts &&
      data.customFonts.length &&
      data.customFonts.map((font: any) => this.getCssFromFont(font)).join(' ')
    )
  }

  getCss(data: any) {
    return (data.cssCode || '') + (this.getFontCss(data) || '')
  }

  get data() {
    return {
      ...this.props.data,
      ...this.state.state
    }
  }

  componentDidUpdate(prevProps: BuilderPageProps) {
    if (this.props.data && prevProps.data !== this.props.data) {
      this.state.update((state: any) => {
        Object.assign(state, this.props.data)
      })
    }
  }


  render() {
    const { content } = this.props
    return (
      <BuilderAsyncRequestsContext.Consumer>
        {value => {
          this._asyncRequests = value && value.requests
          this._errors = value && value.errors
          this._logs = value && value.logs

          return (
            <BuilderStoreContext.Provider
              value={{
                ...this.state,
                state: this.data
              }}
            >
              {/* Global styles */}
              {/* {Builder.isBrowser && (
                <style>
                  {`
                  .builder-block {
                    transition: all 0.2s ease-in-out;
                  }
                `}
                </style>
              )} */}

              {content ? (
                <React.Fragment>
                  {this.getCss(content.data) && (
                    <style dangerouslySetInnerHTML={{ __html: this.getCss(content.data) }} />
                  )}
                  <BuilderBlocks emailMode={this.props.emailMode} fieldName="blocks" blocks={content.data.blocks} />
                </React.Fragment>
              ) : (
                <BuilderContent
                  // TODO: pass entry in
                  contentLoaded={this.onContentLoaded}
                  options={{
                    entry: this.props.entry,
                    ...this.props.options
                  }}
                  contentError={this.props.contentError}
                  modelName={this.name || 'page'}
                >
                  {(data, loading, fullData) => {
                    // TODO: loading option - maybe that is what the children is or component prop
                    return data ? (
                      <div
                        data-builder-component={this.name}
                        data-builder-content-id={fullData.id}
                        data-builder-variation-id={fullData.variationId}
                      >
                        {this.getCss(data) && (
                          <style dangerouslySetInnerHTML={{ __html: this.getCss(data) }} />
                        )}
                        {<BuilderBlocks emailMode={this.props.emailMode} fieldName="blocks" blocks={data.blocks} />}
                        {/* {data.jsCode && <script dangerouslySetInnerHTML={{ __html: data.jsCode }} />} */}
                      </div>
                    ) : loading ? (
                      <div data-builder-component={this.name} className="builder-loading">
                        {this.props.children}
                      </div>
                    ) : (
                      <div data-builder-component={this.name} className="builder-no-content" />
                    )
                  }}
                </BuilderContent>
              )}
            </BuilderStoreContext.Provider>
          )
        }}
      </BuilderAsyncRequestsContext.Consumer>
    )
  }

  evalExpression(expression: string) {
    const { data } = this
    return expression.replace(/{{([^}]+)}}/g, (match, group) => tryEval(group, data, this._errors))
  }

  // TODO: customizable hm
  @Throttle(100, { leading: true, trailing: true })
  throttledHandleRequest(propertyName: string, url: string) {
    return this.handleRequest(propertyName, url)
  }

  async handleRequest(propertyName: string, url: string) {
    // TODO: Builder.isEditing = just checks if iframe and parent page is builder.io or localhost:1234
    if (Builder.isIframe && fetchCache[url]) {
      this.updateState(ctx => {
        ctx[propertyName] = fetchCache[url]
      })
      return fetchCache[url]
    }
    const request = async () => {
      const requestStart = Date.now()
      if (!Builder.isBrowser) {
        console.time('Fetch ' + url)
      }
      let json: any
      try {
        const result = await fetch(url)
        json = await result.json()
      } catch (err) {
        if (this._errors) {
          this._errors.push(err)
        }
        if (this._logs) {
          this._logs.push(`Fetch to ${url} errored in ${Date.now() - requestStart}ms`)
        }
        return
      } finally {
        if (!Builder.isBrowser) {
          console.timeEnd('Fetch ' + url)
          if (this._logs) {
            this._logs.push(`Fetched ${url} in ${Date.now() - requestStart}ms`)
          }
        }
      }

      if (json) {
        if (Builder.isIframe) {
          fetchCache[url] = json
        }
        // TODO: debounce next tick all of these when there are a bunch
        this.updateState(ctx => {
          ctx[propertyName] = json
        })
      }

      return json
    }
    const existing =
      this._asyncRequests &&
      (this._asyncRequests.find(req => isRequestInfo(req) && req.url === url) as RequestInfo | null)
    if (existing) {
      const promise = existing.promise
      promise.then(json => {
        if (json) {
          this.updateState(ctx => {
            ctx[propertyName] = json
          })
        }
      })
      return promise
    }
    const promise = request()
    Builder.nextTick(() => {
      if (this._asyncRequests) {
        this._asyncRequests.push(promise)
      }
    })
    return promise
  }

  unsubscribe() {
    if (this.subscriptions) {
      this.subscriptions.unsubscribe()
      this.subscriptions = new Subscription()
    }
  }

  handleBuilderRequest(propertyName: string, optionsString: string) {
    const options = tryEval(optionsString, this.data, this._errors)
    // TODO: this will screw up for multiple bits of data
    if (this.subscriptions) {
      this.unsubscribe()
    }
    // TODO: don't unsubscribe and resubscribe every time data changes, will make a TON of requests if that's the case when editing...
    // I guess will be cached then
    if (options) {
      // TODO: unsubscribe on destroy
      this.subscriptions.add(
        builder.queueGetContent(options.model, options).subscribe(matches => {
          if (matches) {
            this.updateState(ctx => {
              ctx[propertyName] = matches
            })
          }
        })
      )
    }
  }

  onContentLoaded = (data: any) => {
    // Unsubscribe all?
    if (this.props.contentLoaded) {
      this.props.contentLoaded(data)
    }

    if (data && data.inputs && Array.isArray(data.inputs) && data.inputs.length) {
      if (!data.state) {
        data.state = {}
      }
      data.inputs.forEach((input: any) => {
        if (input) {
          if (input.name && input.defaultValue !== undefined) {
            data.state[input.name] = JSON.stringify(input.defaultValue)
          }
        }
      })
    }

    if (data && data.state) {
      const processed = this.processStateFromApi(data.state)
      this.setState({
        ...this.state,
        state: {
          location: this.locationState,
          deviceSize: this.deviceSizeState,
          ...processed,
          ...this.props.data
        }
      })
    }
    // TODO: diff it against prior code
    // TODO: throttle execution (or --> don't run in preview <--)
    if (data && data.jsCode && !Builder.isIframe) {
      // TODO: real editing method
      try {
        new Function(data.jsCode)(data)
      } catch (error) {
        console.warn('Eval error', error)
      }
    }

    if (data && (data.httpRequests || data.builderData) && !this.props.noAsync) {
      // TODO: another structure for this
      for (const key in data.httpRequests) {
        const url = data.httpRequests[key]
        if (url && !this.data[key]) {
          if (Builder.isBrowser) {
            let lastUrl = this.evalExpression(url)
            this.throttledHandleRequest(key, lastUrl)
            this.subscriptions.add(
              this.onStateChange.subscribe(() => {
                const newUrl = this.evalExpression(url)
                if (newUrl !== lastUrl) {
                  this.throttledHandleRequest(key, newUrl)
                  lastUrl = newUrl
                }
              })
            )
          } else {
            this.handleRequest(key, this.evalExpression(url))
          }
        }
      }

      for (const key in data.builderData) {
        const url = data.builderData[key]
        if (url && !this.data[key]) {
          this.handleBuilderRequest(key, this.evalExpression(url))
        }
      }
    }
  }
}
