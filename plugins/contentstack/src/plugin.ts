import contentstack from 'contentstack';
import pkg from '../package.json';
import {
  registerDataPlugin,
  ResourceType,
  ResourceEntryType,
  APIOperations,
} from '@builder.io/data-plugin-tools';
import kebabCase from 'lodash/capitalize';
import capitalize from 'lodash/kebabCase';
import mapValues from 'lodash/mapValues';
import appState from '@builder.io/app-context';
import { Input } from '@builder.io/sdk';

function humanCase(str = '') {
  if (str.includes('$')) {
    // kebabCase removes the $ but we need to keep it for chart names
    return capitalize(str.replace(/[- ]+/g, ' ').trim());
  }
  return capitalize(
    kebabCase(str)
      .replace(/[- ]+/g, ' ')
      .trim()
  );
}

interface Entity {
  title: string;
  uid: string;
  [index: string]: any;
}

interface ContentType extends Entity {
  description: string;
  schema: {
    data_type: string;
    display_name: string;
    reference_to: [string];
    uid: string;
    [index: string]: any;
  }[];
}

interface Result {
  object: () => any;
}

const buildInputs = (model: ContentType) => (): Input[] => {
  const subFields = model.schema
    // searching by ref UID seems pointless, so we exclude that for now.
    // In the future, we could add searching within references:
    // https://www.contentstack.com/docs/developers/apis/content-delivery-api/#reference-search-equals
    .filter(field => field.data_type !== 'reference')
    .map(
      (field): Input => ({
        name: field.uid,
        friendlyName: field.display_name,
        type: field.data_type,
      })
    );

  const inputs: Input[] = [
    { name: 'limit', type: 'number', defaultValue: 10 },
    {
      name: 'orderBy',
      friendlyName: 'Order By',
      type: 'object',
      subFields: [
        {
          name: 'value',
          friendlyName: 'Order By',
          type: 'string',
          enum: subFields.map(field => ({
            value: field.name,
            label: field.friendlyName ?? '',
          })),
        },
        {
          name: 'order',
          friendlyName: 'order',
          type: 'string',
          enum: [
            {
              value: 'asc',
              label: 'ascending',
            },
            {
              value: 'desc',
              label: 'descending',
            },
          ],
          defaultValue: 'asc',
        },
      ],
    },
    {
      name: 'fields',
      type: 'object',
      advanced: true,
      friendlyName: `Search by ${model.title} fields`,
      subFields,
    },
  ];
  return inputs;
};

registerDataPlugin(
  {
    name: 'Contentstack',
    id: pkg.name,
    icon:
      'https://cdn.builder.io/api/v1/image/assets%2FYJIGb4i01jvw0SRdL5Bt%2F490404fa90f74ec8b6ea44c345e7ba64',
    settings: [
      {
        name: 'apiKey',
        type: 'string',
        required: true,
        helperText:
          'To get your API Key, go to https://app.contentstack.com, choose a Stack and click Settings -> Stack.',
      },
      {
        name: 'deliveryToken',
        type: 'string',
        required: true,
        helperText:
          'https://www.contentstack.com/docs/developers/create-tokens/create-a-delivery-token/',
      },
      {
        name: 'environmentName',
        type: 'string',
        required: true,
        helperText: 'Enter the name of your Stack Environment that you want to read data from.',
      },
    ],
    ctaText: `Connect your ContentStack stack`,
  },
  async settings => {
    const apiKey = settings.get('apiKey')?.trim();
    const deliveryToken = settings.get('deliveryToken')?.trim();
    const environmentName: string = settings.get('environmentName')?.trim();
    const Stack = contentstack.Stack(apiKey, deliveryToken, environmentName);

    const apiOperations: APIOperations = {
      getResourceTypes: async () => {
        const contentTypesResponse = await Stack.getContentTypes();
        // `any` override is to fix https://github.com/contentstack/contentstack-javascript/pull/61
        const contentTypes = (contentTypesResponse as any).content_types as ContentType[];
        const augmentedContentTypes = contentTypes.map(contentType => {
          const references = contentType.schema.filter(field => field.data_type === 'reference');
          // https://www.contentstack.com/docs/developers/apis/content-delivery-api/#include-reference
          const referenceSearchParams = references.map(field => field.uid);

          return { ...contentType, searchParams: { include: referenceSearchParams } };
        });

        const buildHeaders = () => {
          const headers = {
            api_key: apiKey,
            access_token: deliveryToken,
          };

          return Object.entries(headers)
            .map(([key, value]) => `headers.${key}=${value}`)
            .join('&');
        };

        return augmentedContentTypes.map(
          (model): ResourceType => ({
            name: humanCase(model.title),
            id: model.uid,
            description: model.description,
            inputs: buildInputs(model),
            toUrl: options => {
              const buildUrl = (url: string) => {
                const endUrl = `https://cdn.contentstack.io/v3/content_types/${model.uid}/${url}`;
                return `${appState.config.apiRoot()}/api/v1/proxy-api?url=${encodeURIComponent(
                  endUrl
                )}&${buildHeaders()}`;
              };

              /** https://www.contentstack.com/docs/developers/apis/content-delivery-api/#search-by-regex */
              const transformFieldQuery = (query: string) => ({
                $regex: `.*${query}.*`,
                $options: 'i',
              });

              const baseQuery = [
                ['environment', environmentName],
                ...(options.limit ? [['limit', options.limit]] : []),
                ...(options.fields
                  ? [['query', JSON.stringify(mapValues(options.fields, transformFieldQuery))]]
                  : []),
                ...(options.orderBy?.value && options.orderBy?.order
                  ? [[options.orderBy.order, options.orderBy.value]]
                  : []),
              ];

              if (options.entry) {
                const query = new URLSearchParams([
                  ...baseQuery,
                  ['include[]', model.searchParams.include],
                ]);
                return buildUrl(`entries/${options.entry}?${query}`);
              } else {
                const query = new URLSearchParams(baseQuery);
                return buildUrl(`entries?${query}`);
              }
            },
            canPickEntries: true,
          })
        );
      },
      getEntriesByResourceType: async (resourceTypeId, options = {}) => {
        const StackForContentType = Stack.ContentType(resourceTypeId);

        const makeApiRequest = (options: { searchText?: string; resourceEntryId?: string }) => {
          if (options.resourceEntryId) {
            return StackForContentType.Entry(options.resourceEntryId)
              .fetch()
              .then(res => [res]);
          } else if (options.searchText) {
            return StackForContentType.Query()
              .search(options.searchText)
              .find()
              .then(res => res[0]);
          } else {
            return StackForContentType.Query()
              .find()
              .then(res => res[0]);
          }
        };

        const response: Result[] = await makeApiRequest(options);

        return response.map(
          (result): ResourceEntryType => {
            const item = result.object();
            return {
              id: item.uid,
              name: item.title,
            };
          }
        );
      },
    };

    return apiOperations;
  }
);
