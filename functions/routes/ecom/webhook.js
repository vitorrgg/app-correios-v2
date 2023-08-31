const logger = require('firebase-functions/logger')
// read configured E-Com Plus app data
const getAppData = require('./../../lib/store-api/get-app-data')
const updateAppData = require('./../../lib/store-api/update-app-data')
const { newCorreios } = require('../../lib/correios-axios')

const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'

exports.post = ({ appSdk }, req, res) => {
  // receiving notification from Store API
  const { storeId } = req

  /**
   * Treat E-Com Plus trigger body here
   * Ref.: https://developers.e-com.plus/docs/api/#/store/triggers/
   */
  const trigger = req.body

  // get app configured options
  getAppData({ appSdk, storeId })

    .then(appData => {
      if (
        Array.isArray(appData.ignore_triggers) &&
        appData.ignore_triggers.indexOf(trigger.resource) > -1
      ) {
        // ignore current trigger
        const err = new Error()
        err.name = SKIP_TRIGGER_NAME
        throw err
      }

      /* DO YOUR CUSTOM STUFF HERE */
      if (trigger.resource === 'applications' && appData.correios_contract) {
        const {
          username,
          access_code: accessCode,
          post_card_number: postCardNumber
        } = appData.correios_contract
        if (username && accessCode && postCardNumber) {
          newCorreios(storeId, { username, accessCode, postCardNumber })
            .then(async (correios) => {
              if (!appData.services || !appData.services.length) {
                const { cnpj, nuContrato } = correios.$contract
                const { data: { itens } } = await correios({
                  method: 'get',
                  url: `/meucontrato/v1/empresas/${cnpj}/contratos/${nuContrato}/servicos?page=0&size=50`
                })
                const services = itens
                  .filter(({ descricao }) => /^(PAC|SEDEX) CONTRATO AG$/.test(descricao))
                  .map(({ codigo, descricao }) => ({
                    service_code: codigo,
                    label: descricao.replace(' CONTRATO AG', '')
                  }))
                if (services.length) {
                  await updateAppData({ appSdk, storeId }, { services }, true)
                }
              }
              logger.info(`[webhook] #${storeId} correios contract`, {
                contract: correios.$contract
              })
            })
            .catch((err) => {
              if (err.response) {
                logger.warn(`[webhook] cant generate correios token for #${storeId}`, {
                  headers: err.config.headers,
                  body: err.config.data,
                  response: err.response.data,
                  status: err.response.status
                })
              } else {
                logger.error(err)
              }
            })
        }
      }

      // all done
      res.send(ECHO_SUCCESS)
    })

    .catch(err => {
      if (err.name === SKIP_TRIGGER_NAME) {
        // trigger ignored by app configuration
        res.send(ECHO_SKIP)
      } else if (err.appWithoutAuth === true) {
        const msg = `Webhook for ${storeId} unhandled with no authentication found`
        const error = new Error(msg)
        error.trigger = JSON.stringify(trigger)
        console.error(error)
        res.status(412).send(msg)
      } else {
        // console.error(err)
        // request to Store API with error response
        // return error status code
        res.status(500)
        const { message } = err
        res.send({
          error: ECHO_API_ERROR,
          message
        })
      }
    })
}
